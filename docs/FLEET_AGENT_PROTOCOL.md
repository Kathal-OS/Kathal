# KATHAL OS — Fleet Security & Agent Heartbeat Protocol

KATHAL OS Phase 1.5 hardens multi-node Fleet inventory with DNS-resolving network target checks, scoped per-node agent credentials, persistent reachability/metric history, and a lightweight HTTP heartbeat protocol for remote worker nodes (`src/fleet/fleetService.ts`, `src/routes/fleetRoutes.ts`).

---

## 1. Host & DNS SSRF Protections

To prevent Fleet registration and TCP reachability probes from being misused against host-local services or cloud instance metadata endpoints:

1. **Syntax & Hostname Filtering (`isValidRemoteHostSyntax`)**:
   - Rejects `localhost`, `localhost.localdomain`, `ip6-localhost`, `ip6-loopback`, `metadata.google.internal`, `metadata.goog`, `*.internal`, `169.254.169.254`, and malformed hostnames (`HTTP 400`).
2. **Pre-Probe DNS Resolution (`resolveAndValidateTargetIp`)**:
   - Before opening any TCP socket during `POST /api/v1/fleet/servers/:id/probe`, resolves all A/AAAA DNS records for the target hostname (`dns.promises.lookup(host, { all: true })`) and validates **every resolved IP** via `classifyIpAddress`.
   - Always blocks:
     - Loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x`)
     - Link-local & cloud metadata (`169.254.0.0/16`, `fe80::/10`, `::ffff:169.254.x`)
     - Unspecified (`0.0.0.0/8`, `::`)
     - Multicast & reserved (`224.0.0.0/4`, `240.0.0.0/4`, `ff00::/8`)
   - Private RFC1918 / ULA ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`):
     - Controlled by `KATHAL_FLEET_ALLOW_PRIVATE_NETWORKS` (default `true` for homelab/LAN deployments; set `false` to enforce public-routable worker IPs only, with per-probe `allowPrivate` override gated by `servers.update`).

---

## 2. Node Enrollment & Agent Credential Rotation

- **Enrollment (`POST /api/v1/fleet/servers`, permission `servers.create`)**:
  - When `authMethod: "agent-token"` is selected, KATHAL generates a unique `agentId` (`agt-<hex>`) and a random `agentToken` (`kat_<48 hex>`).
  - Only the SHA-256 hash (`agent_token_hash`) is persisted in SQLite (`servers`); the raw `agentToken` is returned **once** at creation or rotation time.
- **Rotation (`POST /api/v1/fleet/servers/:id/agent-token`, permission `servers.update`)**:
  - Mints a new `kat_...` token, invalidates the previous token hash immediately, updates `agent_token_rotated_at`, and records a `fleet.agent_token_rotate` audit event.
- **Control-Plane Protection**:
  - The primary local control-plane node (`local-primary`, `is_local = 1`) cannot be deleted (`DELETE /api/v1/fleet/servers/:id` -> `400`) and does not accept remote agent tokens.

---

## 3. Agent Heartbeat Wire Protocol

Remote `kathal-agent` processes authenticate directly with their scoped `agentId` + `agentToken` (verified in constant time with `safeEqualStrings(sha256Hex(rawToken), agent_token_hash)`):

- **Endpoint**: `POST /api/v1/fleet/agent/heartbeat`
- **Headers**:
  - `Authorization: Bearer <agentToken>`
  - `X-Kathal-Agent-Id: <agentId>` *(or supplied as `agentId` in the JSON body)*
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "agentId": "agt-a1b2c3d4e5f6",
    "agentVersion": "0.1.5",
    "os": "Linux 6.8",
    "arch": "x86_64",
    "cpuPercent": 14.2,
    "memoryPercent": 41.8,
    "diskPercent": 28.5
  }
  ```
- **Response (`200 OK`)**:
  ```json
  {
    "status": "acknowledged",
    "server": { "id": "srv-...", "status": "online", "lastHeartbeatAt": "..." }
  }
  ```
- **Audit & Telemetry History**: Each successful probe or heartbeat appends a row to `server_status_history` (`GET /api/v1/fleet/servers/:id/history?limit=50`, permission `servers.read`); rejected agent heartbeats return `401` and log `fleet.agent_heartbeat` (`outcome: 'denied'`).
