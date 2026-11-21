import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { samplePidResourceMetrics, formatProcessUptime } from './nativeProcess.ts'

export type LocalRuntimeKind =
  | 'static'
  | 'node'
  | 'python'
  | 'cms'
  | 'monitor'
  | 'dashboard'
  | 'kv'
  | 'sqlite'
  | 'git'

export interface LocalLogLine {
  timestamp: string
  stream: 'stdout' | 'stderr'
  content: string
}

export interface LocalAppInstance {
  id: string
  name: string
  runtime: LocalRuntimeKind
  runtimeLabel: string
  image: string
  state: 'running' | 'exited'
  pid: number | null
  port: number
  containerPort: number
  appDir: string
  entryExecutable: string
  entryArgs: string[]
  env: Record<string, string>
  repoUrl?: string
  branch?: string
  commit?: string
  created: number
  startedAt: number | null
  lastExitCode: number | null
  logs: LocalLogLine[]
  child?: ChildProcess
}

const APPS_ROOT = path.resolve(
  process.env.KATHAL_APPS_DIR || path.join(os.tmpdir(), 'kathal-apps')
)

function ensureAppsRoot() {
  fs.mkdirSync(APPS_ROOT, { recursive: true })
}

export function sanitizeAppName(rawName: string): string {
  const cleaned = String(rawName || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return cleaned || `app-${crypto.randomBytes(2).toString('hex')}`
}

export function resolveConfinedAppDir(appName: string): string {
  ensureAppsRoot()
  const safeName = sanitizeAppName(appName)
  const resolved = path.resolve(APPS_ROOT, safeName)
  if (!resolved.startsWith(APPS_ROOT + path.sep)) {
    throw new Error('Invalid application directory path')
  }
  return resolved
}

export function isValidPublicHttpsGitUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return false
    if (host.startsWith('169.254.') || host.startsWith('10.') || host.startsWith('192.168.')) {
      return false
    }
    const octets = host.split('.')
    if (octets.length === 4 && octets[0] === '172') {
      const second = Number(octets[1])
      if (second >= 16 && second <= 31) return false
    }
    return true
  } catch {
    return false
  }
}

export function validateLocalProxyTarget(rawTarget: string): { ok: true; url: URL } | { ok: false; error: string } {
  try {
    const parsed = new URL(rawTarget)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Target URL must use http:// or https://' }
    }
    const host = parsed.hostname.toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost') {
      return {
        ok: false,
        error: 'Reverse proxy targets must point to a local app (http://127.0.0.1:<port> or http://localhost:<port>)',
      }
    }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, error: 'Target port must be between 1024 and 65535' }
    }
    return { ok: true, url: parsed }
  } catch {
    return { ok: false, error: 'Invalid target URL format' }
  }
}

export function isValidDomainName(rawDomain: string): boolean {
  const d = String(rawDomain || '').trim().toLowerCase()
  if (!d || d.length > 253) return false
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(d)
}

function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen(port, '127.0.0.1')
  })
}

function waitForPortOpen(port: number, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = new net.Socket()
      socket.setTimeout(350)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      const retry = () => {
        socket.destroy()
        if (Date.now() - start >= timeoutMs) {
          resolve(false)
        } else {
          setTimeout(attempt, 120)
        }
      }
      socket.once('error', retry)
      socket.once('timeout', retry)
      socket.connect(port, '127.0.0.1')
    }
    attempt()
  })
}

export function probeLocalHttp(
  port: number,
  reqPath = '/'
): Promise<{ ok: boolean; statusCode: number | null; latencyMs: number; error?: string }> {
  const start = Date.now()
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method: 'GET',
        timeout: 2500,
      },
      (res) => {
        res.resume()
        resolve({
          ok: (res.statusCode || 500) < 500,
          statusCode: res.statusCode || null,
          latencyMs: Date.now() - start,
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, statusCode: null, latencyMs: Date.now() - start, error: 'Timeout' })
    })
    req.on('error', (err) => {
      resolve({ ok: false, statusCode: null, latencyMs: Date.now() - start, error: err.message })
    })
    req.end()
  })
}

function runCommandNoShell(
  cmd: string,
  args: string[],
  cwd: string,
  onLog?: (stream: 'stdout' | 'stderr', text: string) => void,
  timeoutMs = 120000
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    const handleChunk = (stream: 'stdout' | 'stderr', buf: Buffer) => {
      const text = buf.toString('utf8')
      output += text
      if (onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onLog(stream, line)
        }
      }
    }

    child.stdout?.on('data', (d: Buffer) => handleChunk('stdout', d))
    child.stderr?.on('data', (d: Buffer) => handleChunk('stderr', d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
  })
}

export function inferRuntimeFromInput(hint: string): {
  runtime: LocalRuntimeKind
  label: string
} {
  const s = String(hint || '').toLowerCase()
  if (s.includes('wordpress') || s.includes('ghost') || s.includes('drupal') || s === 'cms') {
    return { runtime: 'cms', label: 'Node.js CMS & Blog' }
  }
  if (s.includes('uptime') || s === 'monitor') {
    return { runtime: 'monitor', label: 'Node.js Uptime Monitor' }
  }
  if (s.includes('grafana') || s.includes('prometheus') || s === 'dashboard') {
    return { runtime: 'dashboard', label: 'Node.js Metrics Dashboard' }
  }
  if (s.includes('redis') || s.includes('valkey') || s === 'kv') {
    return { runtime: 'kv', label: 'Node.js Key-Value Store' }
  }
  if (s.includes('postgres') || s.includes('mysql') || s.includes('mariadb') || s.includes('mongo') || s === 'sqlite' || s === 'db') {
    return { runtime: 'sqlite', label: 'Python SQLite Studio' }
  }
  if (s.includes('python') || s.includes('flask') || s.includes('fastapi')) {
    return { runtime: 'python', label: 'Python 3 Web App' }
  }
  if (s.includes('node') || s.includes('api') || s.includes('gitea') || s.includes('code')) {
    return { runtime: 'node', label: 'Node.js Web App' }
  }
  return { runtime: 'static', label: 'Static Web Server' }
}

function writeScaffoldFiles(
  appDir: string,
  appName: string,
  runtime: LocalRuntimeKind,
  customHtml?: string
): { executable: string; args: string[]; runtimeLabel: string } {
  fs.mkdirSync(appDir, { recursive: true })

  if (runtime === 'static') {
    const publicDir = path.join(appDir, 'public')
    fs.mkdirSync(publicDir, { recursive: true })
    const html =
      customHtml?.trim() ||
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(appName)} · Hosted by KATHAL</title>
  <style>
    body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:#0b0f17; color:#f1f5f9; display:grid; place-items:center; min-height:100vh; padding:24px; }
    .card { max-width:560px; width:100%; background:#111827; border:1px solid #1e293b; border-radius:16px; padding:32px; }
    .badge { display:inline-block; font-size:12px; color:#4ade80; background:rgba(34,197,94,.12); border:1px solid rgba(34,197,94,.3); padding:4px 10px; border-radius:999px; margin-bottom:16px; }
    h1 { margin:0 0 8px; font-size:28px; }
    p { color:#94a3b8; line-height:1.6; margin:0 0 16px; font-size:15px; }
    code { background:#020617; border:1px solid #1e293b; padding:2px 8px; border-radius:6px; font-size:13px; color:#e2e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Live Local Web App (No Docker)</span>
    <h1>${escapeHtml(appName)}</h1>
    <p>This website is running directly as a local server process on your host and is connected to KATHAL's reverse proxy.</p>
    <p>Static files are served from <code>${escapeHtml(publicDir)}</code>.</p>
  </div>
</body>
</html>`
    fs.writeFileSync(path.join(publicDir, 'index.html'), html, 'utf8')
    fs.writeFileSync(
      path.join(appDir, 'server.mjs'),
      buildStaticServerScript(publicDir, appName),
      'utf8'
    )
    return { executable: process.execPath, args: ['server.mjs'], runtimeLabel: 'Static Web Server' }
  }

  if (runtime === 'cms') {
    const dataPath = path.join(appDir, 'posts.json')
    if (!fs.existsSync(dataPath)) {
      fs.writeFileSync(
        dataPath,
        JSON.stringify(
          [
            {
              id: 'welcome',
              title: `Welcome to ${appName}`,
              body: 'Your local CMS & Blog is running natively without Docker. Publish or edit posts directly below!',
              createdAt: new Date().toISOString(),
            },
          ],
          null,
          2
        ),
        'utf8'
      )
    }
    fs.writeFileSync(path.join(appDir, 'server.mjs'), buildCmsServerScript(appName), 'utf8')
    return { executable: process.execPath, args: ['server.mjs'], runtimeLabel: 'Node.js CMS & Blog' }
  }

  if (runtime === 'monitor') {
    fs.writeFileSync(path.join(appDir, 'server.mjs'), buildMonitorServerScript(appName), 'utf8')
    return { executable: process.execPath, args: ['server.mjs'], runtimeLabel: 'Node.js Uptime Monitor' }
  }

  if (runtime === 'dashboard') {
    fs.writeFileSync(path.join(appDir, 'server.mjs'), buildDashboardServerScript(appName), 'utf8')
    return { executable: process.execPath, args: ['server.mjs'], runtimeLabel: 'Node.js Metrics Dashboard' }
  }

  if (runtime === 'kv') {
    const kvPath = path.join(appDir, 'kv.json')
    if (!fs.existsSync(kvPath)) {
      fs.writeFileSync(kvPath, JSON.stringify({ app: appName, status: 'ready' }, null, 2), 'utf8')
    }
    fs.writeFileSync(path.join(appDir, 'server.mjs'), buildKvServerScript(appName), 'utf8')
    return { executable: process.execPath, args: ['server.mjs'], runtimeLabel: 'Node.js Key-Value Store' }
  }

  if (runtime === 'sqlite') {
    fs.writeFileSync(path.join(appDir, 'app.py'), buildPythonSqliteStudioScript(appName), 'utf8')
    return { executable: 'python3', args: ['-u', 'app.py'], runtimeLabel: 'Python SQLite Studio' }
  }

  if (runtime === 'python') {
    fs.writeFileSync(path.join(appDir, 'app.py'), buildPythonWebAppScript(appName), 'utf8')
    return { executable: 'python3', args: ['-u', 'app.py'], runtimeLabel: 'Python 3 Web App' }
  }

  // Default: 'node'
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: appName, version: '1.0.0', type: 'module', scripts: { start: 'node server.mjs' } }, null, 2),
    'utf8'
  )
  fs.writeFileSync(path.join(appDir, 'server.mjs'), buildNodeApiServerScript(appName), 'utf8')
  return { executable: process.execPath, args: ['server.mjs'], runtimeLabel: 'Node.js Web App' }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildStaticServerScript(publicDir: string, appName: string): string {
  return `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 9000);
const PUBLIC_DIR = ${JSON.stringify(publicDir)};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: ${JSON.stringify(appName)}, pid: process.pid }));
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  let filePath = target;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[${appName}] static web server listening on http://127.0.0.1:' + PORT);
});
`
}

function buildNodeApiServerScript(appName: string): string {
  return `import http from 'node:http';
import os from 'node:os';

const PORT = Number(process.env.PORT || 9000);
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz' || urlPath === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      app: ${JSON.stringify(appName)},
      runtime: 'Node.js ' + process.version,
      pid: process.pid,
      port: PORT,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      hostname: os.hostname(),
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(\`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(appName)}</title>
  <style>body{margin:0;font-family:system-ui,sans-serif;background:#0b0f17;color:#f1f5f9;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:560px;width:100%;background:#111827;border:1px solid #1e293b;border-radius:16px;padding:32px}h1{margin:0 0 8px}p,li{color:#94a3b8;font-size:14px}code{color:#e0644d;background:#020617;padding:2px 6px;border-radius:4px}</style></head>
  <body><div class="card"><h1>${escapeHtml(appName)}</h1><p>Live Node.js web app running directly on host port <code>\${PORT}</code> (PID <code>\${process.pid}</code>).</p>
  <p>JSON API endpoint: <a href="api/info" style="color:#e0644d"><code>api/info</code></a> · Health: <code>healthz</code></p></div></body></html>\`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[${appName}] Node.js server listening on http://127.0.0.1:' + PORT);
});
`
}

function buildCmsServerScript(appName: string): string {
  return `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 9000);
const DATA_FILE = path.join(process.cwd(), 'posts.json');

function readPosts() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function writePosts(posts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2), 'utf8');
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: ${JSON.stringify(appName)} }));
    return;
  }
  if (urlPath === '/api/posts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readPosts()));
    return;
  }
  if (urlPath === '/api/posts' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const posts = readPosts();
        const item = {
          id: Date.now().toString(36),
          title: String(parsed.title || 'Untitled Post').slice(0, 120),
          body: String(parsed.body || '').slice(0, 4000),
          createdAt: new Date().toISOString(),
        };
        posts.unshift(item);
        writePosts(posts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(item));
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(\`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(appName)} · Local CMS</title>
  <style>body{margin:0;font-family:system-ui,sans-serif;background:#0b0f17;color:#f1f5f9;padding:32px 16px}.wrap{max-width:720px;margin:0 auto}.card{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:20px;margin-bottom:16px}input,textarea{width:100%;box-sizing:border-box;background:#020617;border:1px solid #1e293b;color:#f1f5f9;padding:10px;border-radius:8px;margin-bottom:10px;font:inherit}button{background:#cc482e;color:#fff;border:0;padding:10px 16px;border-radius:8px;cursor:pointer;font-weight:600}small{color:#94a3b8}</style></head>
  <body><div class="wrap"><h1>${escapeHtml(appName)}</h1><p style="color:#94a3b8">Local Node.js CMS & Blog running on port \${PORT} (PID \${process.pid})</p>
  <form class="card" id="f"><h3>Publish New Post</h3><input id="t" placeholder="Post title" required /><textarea id="b" rows="3" placeholder="Write something..."></textarea><button type="submit">Publish Post</button></form>
  <div id="posts"></div></div>
  <script>
    function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
    async function load(){const r=await fetch('api/posts');const list=await r.json();document.getElementById('posts').innerHTML=list.map(p=>'<div class="card"><h3>'+esc(p.title)+'</h3><p>'+esc(p.body)+'</p><small>'+esc(new Date(p.createdAt).toLocaleString())+'</small></div>').join('');}
    document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();await fetch('api/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:t.value,body:b.value})});t.value='';b.value='';load();};
    load();
  </script></body></html>\`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[${appName}] Local CMS listening on http://127.0.0.1:' + PORT);
});
`
}

function buildMonitorServerScript(appName: string): string {
  return `import http from 'node:http';
import os from 'node:os';

const PORT = Number(process.env.PORT || 9000);
const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz' || urlPath === '/api/checks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      app: ${JSON.stringify(appName)},
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      loadAvg: os.loadavg(),
      memFreeMb: Math.round(os.freemem() / 1048576),
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(\`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(appName)} · Uptime Monitor</title>
  <style>body{margin:0;font-family:system-ui,sans-serif;background:#0b0f17;color:#f1f5f9;padding:32px}.card{max-width:680px;margin:0 auto;background:#111827;border:1px solid #1e293b;border-radius:14px;padding:24px}.ok{color:#4ade80;font-weight:600}</style></head>
  <body><div class="card"><h1>${escapeHtml(appName)}</h1><p class="ok">Operational · Port \${PORT} · PID \${process.pid}</p><pre id="out" style="background:#020617;padding:16px;border-radius:8px;overflow:auto"></pre></div>
  <script>async function tick(){const r=await fetch('api/checks');document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2);}tick();setInterval(tick,3000);</script></body></html>\`);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('[${appName}] Uptime Monitor listening on http://127.0.0.1:' + PORT);
});
`
}

function buildDashboardServerScript(appName: string): string {
  return buildMonitorServerScript(appName)
}

function buildKvServerScript(appName: string): string {
  return `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 9000);
const KV_FILE = path.join(process.cwd(), 'kv.json');
function readKv() { try { return JSON.parse(fs.readFileSync(KV_FILE, 'utf8')); } catch { return {}; } }
function writeKv(obj) { fs.writeFileSync(KV_FILE, JSON.stringify(obj, null, 2), 'utf8'); }

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: ${JSON.stringify(appName)} }));
    return;
  }
  if (urlPath === '/api/kv' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readKv()));
    return;
  }
  if (urlPath === '/api/kv' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      try {
        const { key, value } = JSON.parse(body || '{}');
        if (!key) { res.writeHead(400); res.end('key required'); return; }
        const data = readKv();
        data[String(key)] = value;
        writeKv(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch { res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(\`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(appName)} · KV Store</title>
  <style>body{margin:0;font-family:system-ui,sans-serif;background:#0b0f17;color:#f1f5f9;padding:32px}.card{max-width:680px;margin:0 auto;background:#111827;border:1px solid #1e293b;border-radius:14px;padding:24px}input{background:#020617;border:1px solid #1e293b;color:#f1f5f9;padding:8px 10px;border-radius:8px;margin-right:8px}button{background:#cc482e;color:#fff;border:0;padding:8px 14px;border-radius:8px;cursor:pointer}</style></head>
  <body><div class="card"><h1>${escapeHtml(appName)}</h1><p style="color:#94a3b8">Local Persistent Key-Value Store (Port \${PORT})</p>
  <form id="f"><input id="k" placeholder="Key" required /><input id="v" placeholder="Value" required /><button type="submit">Set</button></form>
  <pre id="out" style="background:#020617;padding:16px;border-radius:8px;margin-top:16px"></pre></div>
  <script>async function load(){const r=await fetch('api/kv');out.textContent=JSON.stringify(await r.json(),null,2);}f.onsubmit=async(e)=>{e.preventDefault();await fetch('api/kv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k.value,value:v.value})});k.value='';v.value='';load();};load();</script></body></html>\`);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('[${appName}] Local KV Store listening on http://127.0.0.1:' + PORT);
});
`
}

function buildPythonWebAppScript(appName: string): string {
  return `import os, json
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", "9000"))

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/healthz" or path == "/api/info":
            payload = json.dumps({"status": "ok", "app": ${JSON.stringify(appName)}, "runtime": "Python 3", "pid": os.getpid(), "port": PORT}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
            return
        html = f"""<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(appName)}</title>
        <style>body{{margin:0;font-family:system-ui,sans-serif;background:#0b0f17;color:#f1f5f9;display:grid;place-items:center;min-height:100vh}}.card{{max-width:560px;background:#111827;border:1px solid #1e293b;border-radius:16px;padding:32px}}</style></head>
        <body><div class="card"><h1>${escapeHtml(appName)}</h1><p style="color:#94a3b8">Live Python 3 web app running on host port {PORT} (PID {os.getpid()}).</p></div></body></html>""".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html)
    def log_message(self, fmt, *args):
        print(f"[${appName}] " + (fmt % args), flush=True)

print(f"[${appName}] Python web app listening on http://127.0.0.1:{PORT}", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`
}

function buildPythonSqliteStudioScript(appName: string): string {
  return `import os, json, sqlite3
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", "9000"))
DB_PATH = os.path.join(os.getcwd(), "database.sqlite")

conn = sqlite3.connect(DB_PATH, check_same_thread=False)
conn.execute("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
conn.commit()
conn.close()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "engine": "sqlite3", "db": DB_PATH}).encode())
            return
        if path == "/api/rows":
            c = sqlite3.connect(DB_PATH)
            rows = c.execute("SELECT id, name, created_at FROM items ORDER BY id DESC LIMIT 100").fetchall()
            c.close()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps([{"id": r[0], "name": r[1], "created_at": r[2]} for r in rows]).encode())
            return
        html = f"""<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(appName)} · Local SQLite DB</title>
        <style>body{{margin:0;font-family:system-ui,sans-serif;background:#0b0f17;color:#f1f5f9;padding:32px}}.card{{max-width:680px;margin:0 auto;background:#111827;border:1px solid #1e293b;border-radius:14px;padding:24px}}input{{background:#020617;border:1px solid #1e293b;color:#f1f5f9;padding:8px 10px;border-radius:8px;margin-right:8px}}button{{background:#cc482e;color:#fff;border:0;padding:8px 14px;border-radius:8px;cursor:pointer}}</style></head>
        <body><div class="card"><h1>${escapeHtml(appName)}</h1><p style="color:#94a3b8">Local SQLite3 Database + Web Studio (Port {PORT} · PID {os.getpid()})</p>
        <form id="f"><input id="n" placeholder="Insert record name..." required /><button type="submit">Insert Row</button></form>
        <pre id="out" style="background:#020617;padding:16px;border-radius:8px;margin-top:16px"></pre></div>
        <script>async function load(){{const r=await fetch('api/rows');out.textContent=JSON.stringify(await r.json(),null,2);}}f.onsubmit=async(e)=>{{e.preventDefault();await fetch('api/rows',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{name:n.value}})}});n.value='';load();}};load();</script></body></html>""".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html)

    def do_POST(self):
        if self.path.split("?")[0] == "/api/rows":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8", errors="ignore")
            data = json.loads(raw or "{}")
            name = str(data.get("name", "")).strip()
            c = sqlite3.connect(DB_PATH)
            c.execute("INSERT INTO items (name) VALUES (?)", (name or "item",))
            c.commit()
            c.close()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, fmt, *args):
        print(f"[${appName}] " + (fmt % args), flush=True)

print(f"[${appName}] SQLite Studio listening on http://127.0.0.1:{PORT}", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`
}

export class LocalRuntimeManager {
  apps = new Map<string, LocalAppInstance>()

  constructor() {
    ensureAppsRoot()
    const cleanupAll = () => {
      for (const app of this.apps.values()) {
        if (app.child && !app.child.killed) {
          try {
            app.child.kill('SIGTERM')
          } catch {
            // ignore
          }
        }
      }
    }
    process.once('exit', cleanupAll)
    process.once('SIGINT', cleanupAll)
    process.once('SIGTERM', cleanupAll)
  }

  getAppsRoot(): string {
    return APPS_ROOT
  }

  async allocateFreePort(preferredPort?: number): Promise<number> {
    const usedByApps = new Set(Array.from(this.apps.values()).map((a) => a.port))
    let candidate =
      preferredPort && preferredPort >= 9000 && preferredPort <= 64000 ? preferredPort : 9000
    for (let i = 0; i < 500; i += 1) {
      if (!usedByApps.has(candidate) && candidate !== Number(process.env.PORT || 3000)) {
        const free = await checkPortFree(candidate)
        if (free) return candidate
      }
      candidate += 1
      if (candidate > 64000) candidate = 9000
    }
    throw new Error('No free local port available')
  }

  appendLog(app: LocalAppInstance, stream: 'stdout' | 'stderr', content: string) {
    const clean = content.trimEnd()
    if (!clean) return
    app.logs.push({ timestamp: new Date().toISOString(), stream, content: clean })
    if (app.logs.length > 500) {
      app.logs = app.logs.slice(-500)
    }
  }

  async spawnAppProcess(app: LocalAppInstance): Promise<void> {
    if (app.child && app.state === 'running') {
      await this.stopApp(app.id)
    }
    app.port = await this.allocateFreePort(app.port)
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...app.env,
      PORT: String(app.port),
      HOST: '127.0.0.1',
    }
    this.appendLog(
      app,
      'stdout',
      `[${app.name}] Starting local process: ${app.entryExecutable} ${app.entryArgs.join(' ')} on 127.0.0.1:${app.port}`
    )

    const child = spawn(app.entryExecutable, app.entryArgs, {
      cwd: app.appDir,
      shell: false,
      env: childEnv,
    })

    app.child = child
    app.pid = child.pid ?? null
    app.state = 'running'
    app.startedAt = Date.now()
    app.lastExitCode = null

    child.stdout?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.appendLog(app, 'stdout', line)
      }
    })
    child.stderr?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.appendLog(app, 'stderr', line)
      }
    })
    child.on('exit', (code) => {
      if (app.child === child) {
        app.state = 'exited'
        app.pid = null
        app.lastExitCode = code ?? 0
        app.child = undefined
        this.appendLog(app, code === 0 ? 'stdout' : 'stderr', `[${app.name}] Process exited (code ${code ?? 0})`)
      }
    })

    const listening = await waitForPortOpen(app.port, 3500)
    if (listening) {
      this.appendLog(app, 'stdout', `[${app.name}] Verified live TCP listener on http://127.0.0.1:${app.port} (PID ${app.pid})`)
    } else if (app.state === 'running') {
      this.appendLog(app, 'stdout', `[${app.name}] Process running (PID ${app.pid})`)
    }
  }

  async deployLocalApp(opts: {
    name: string
    runtimeHint?: string
    runtime?: LocalRuntimeKind
    hostPort?: number
    env?: Record<string, string>
    customHtml?: string
    imageLabel?: string
  }): Promise<LocalAppInstance> {
    const cleanName = sanitizeAppName(opts.name)
    const appDir = resolveConfinedAppDir(cleanName)
    const inferred = opts.runtime
      ? { runtime: opts.runtime, label: opts.runtime }
      : inferRuntimeFromInput(opts.runtimeHint || opts.imageLabel || cleanName)

    const existing = this.findByName(cleanName)
    if (existing && existing.state === 'running') {
      await this.stopApp(existing.id)
    }

    const scaffold = writeScaffoldFiles(appDir, cleanName, inferred.runtime, opts.customHtml)
    const port = await this.allocateFreePort(opts.hostPort)

    const instance: LocalAppInstance = existing || {
      id: `proc-${crypto.randomBytes(5).toString('hex')}`,
      name: cleanName,
      runtime: inferred.runtime,
      runtimeLabel: scaffold.runtimeLabel,
      image: opts.imageLabel || `local:${inferred.runtime}`,
      state: 'exited',
      pid: null,
      port,
      containerPort: port,
      appDir,
      entryExecutable: scaffold.executable,
      entryArgs: scaffold.args,
      env: opts.env || {},
      created: Math.floor(Date.now() / 1000),
      startedAt: null,
      lastExitCode: null,
      logs: [],
    }

    instance.runtime = inferred.runtime
    instance.runtimeLabel = scaffold.runtimeLabel
    instance.image = opts.imageLabel || `local:${inferred.runtime}`
    instance.appDir = appDir
    instance.entryExecutable = scaffold.executable
    instance.entryArgs = scaffold.args
    instance.port = port
    instance.containerPort = port
    if (opts.env) instance.env = opts.env

    this.appendLog(instance, 'stdout', `[${cleanName}] Installed ${scaffold.runtimeLabel} files into ${appDir}`)
    this.apps.set(instance.id, instance)
    await this.spawnAppProcess(instance)
    return instance
  }

  async deployFromGit(opts: {
    name: string
    repoUrl: string
    branch?: string
    port?: number
    env?: Record<string, string>
  }): Promise<{ app: LocalAppInstance; commit: string; buildLogs: string[] }> {
    if (!isValidPublicHttpsGitUrl(opts.repoUrl)) {
      throw new Error('Git repository URL must be a valid public https:// URL')
    }
    const cleanName = sanitizeAppName(opts.name)
    const appDir = resolveConfinedAppDir(cleanName)
    const branch = String(opts.branch || 'main').replace(/[^a-zA-Z0-9._/-]/g, '') || 'main'
    const buildLogs: string[] = []
    const logLine = (msg: string) => {
      buildLogs.push(msg)
    }

    const existing = this.findByName(cleanName)
    if (existing && existing.state === 'running') {
      await this.stopApp(existing.id)
    }

    if (fs.existsSync(path.join(appDir, '.git'))) {
      logLine(`> Pulling latest changes from branch "${branch}" in ${appDir}`)
      const pullRes = await runCommandNoShell('git', ['pull', '--ff-only', 'origin', branch], appDir, (_s, l) =>
        logLine(l)
      )
      if (pullRes.code !== 0) {
        throw new Error(`git pull failed (exit ${pullRes.code})`)
      }
    } else {
      fs.rmSync(appDir, { recursive: true, force: true })
      ensureAppsRoot()
      logLine(`> Cloning ${opts.repoUrl} (branch "${branch}") into ${appDir}`)
      const cloneRes = await runCommandNoShell(
        'git',
        ['clone', '--depth', '1', '--branch', branch, '--', opts.repoUrl, appDir],
        APPS_ROOT,
        (_s, l) => logLine(l)
      )
      if (cloneRes.code !== 0) {
        throw new Error(`git clone failed (exit ${cloneRes.code})`)
      }
    }

    let commit = crypto.randomBytes(4).toString('hex').slice(0, 7)
    try {
      const rev = await runCommandNoShell('git', ['rev-parse', '--short', 'HEAD'], appDir)
      if (rev.code === 0 && rev.output.trim()) commit = rev.output.trim()
    } catch {
      // keep generated short id
    }
    logLine(`> Checked out commit ${commit}`)

    // Detect runtime safely without arbitrary shell commands
    let executable = process.execPath
    let args: string[] = ['server.mjs']
    let runtimeLabel = 'Git Static Site'
    const pkgPath = path.join(appDir, 'package.json')

    if (fs.existsSync(pkgPath)) {
      logLine('> Detected package.json — installing dependencies via npm...')
      const npmRes = await runCommandNoShell(
        'npm',
        ['install', '--no-audit', '--no-fund', '--omit=dev'],
        appDir,
        (_s, l) => logLine(l),
        180000
      )
      if (npmRes.code !== 0) {
        throw new Error(`npm install failed (exit ${npmRes.code})`)
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        main?: string
        scripts?: Record<string, string>
      }
      if (pkg.scripts?.start) {
        executable = 'npm'
        args = ['run', 'start']
        runtimeLabel = 'Git Node.js App'
      } else {
        const candidate = [pkg.main, 'server.js', 'server.mjs', 'index.js', 'app.js'].find(
          (f) => f && fs.existsSync(path.join(appDir, f))
        )
        if (candidate) {
          executable = process.execPath
          args = [candidate]
          runtimeLabel = 'Git Node.js App'
        } else {
          const staticDir = ['dist', 'build', 'public'].find((d) =>
            fs.existsSync(path.join(appDir, d, 'index.html'))
          )
          const serveRoot = staticDir ? path.join(appDir, staticDir) : appDir
          fs.writeFileSync(
            path.join(appDir, '.kathal-static.mjs'),
            buildStaticServerScript(serveRoot, cleanName),
            'utf8'
          )
          executable = process.execPath
          args = ['.kathal-static.mjs']
          runtimeLabel = 'Git Static Web App'
        }
      }
    } else if (['app.py', 'main.py', 'server.py'].some((f) => fs.existsSync(path.join(appDir, f)))) {
      const pyFile = ['app.py', 'main.py', 'server.py'].find((f) => fs.existsSync(path.join(appDir, f)))!
      executable = 'python3'
      args = ['-u', pyFile]
      runtimeLabel = 'Git Python App'
    } else {
      const staticDir = ['dist', 'build', 'public'].find((d) =>
        fs.existsSync(path.join(appDir, d, 'index.html'))
      )
      const serveRoot = staticDir ? path.join(appDir, staticDir) : appDir
      fs.writeFileSync(
        path.join(appDir, '.kathal-static.mjs'),
        buildStaticServerScript(serveRoot, cleanName),
        'utf8'
      )
      executable = process.execPath
      args = ['.kathal-static.mjs']
      runtimeLabel = 'Git Static Site'
    }

    const port = await this.allocateFreePort(opts.port)
    const instance: LocalAppInstance = existing || {
      id: `proc-${crypto.randomBytes(5).toString('hex')}`,
      name: cleanName,
      runtime: 'git',
      runtimeLabel,
      image: `git:${commit}`,
      state: 'exited',
      pid: null,
      port,
      containerPort: port,
      appDir,
      entryExecutable: executable,
      entryArgs: args,
      env: opts.env || {},
      repoUrl: opts.repoUrl,
      branch,
      commit,
      created: Math.floor(Date.now() / 1000),
      startedAt: null,
      lastExitCode: null,
      logs: [],
    }
    instance.runtime = 'git'
    instance.runtimeLabel = runtimeLabel
    instance.image = `git:${commit}`
    instance.entryExecutable = executable
    instance.entryArgs = args
    instance.port = port
    instance.containerPort = port
    instance.repoUrl = opts.repoUrl
    instance.branch = branch
    instance.commit = commit
    if (opts.env) instance.env = opts.env
    for (const line of buildLogs) {
      this.appendLog(instance, 'stdout', line)
    }

    this.apps.set(instance.id, instance)
    await this.spawnAppProcess(instance)
    logLine(`> Running live on http://127.0.0.1:${instance.port} (PID ${instance.pid})`)
    return { app: instance, commit, buildLogs }
  }

  async stopApp(id: string): Promise<LocalAppInstance | null> {
    const app = this.apps.get(id)
    if (!app) return null
    const child = app.child
    if (child && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          resolve()
        }, 1800)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        try {
          child.kill('SIGTERM')
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    app.state = 'exited'
    app.pid = null
    app.child = undefined
    return app
  }

  async startApp(id: string): Promise<LocalAppInstance | null> {
    const app = this.apps.get(id)
    if (!app) return null
    await this.spawnAppProcess(app)
    return app
  }

  async restartApp(id: string): Promise<LocalAppInstance | null> {
    const app = this.apps.get(id)
    if (!app) return null
    await this.stopApp(id)
    await this.spawnAppProcess(app)
    return app
  }

  async deleteApp(id: string): Promise<boolean> {
    const app = this.apps.get(id)
    if (!app) return false
    await this.stopApp(id)
    this.apps.delete(id)
    if (app.appDir && app.appDir.startsWith(APPS_ROOT + path.sep)) {
      fs.rmSync(app.appDir, { recursive: true, force: true })
    }
    return true
  }

  findByName(name: string): LocalAppInstance | undefined {
    const clean = sanitizeAppName(name)
    return Array.from(this.apps.values()).find((a) => a.name === clean)
  }

  listApps(): LocalAppInstance[] {
    return Array.from(this.apps.values()).sort((a, b) => b.created - a.created)
  }

  getAppLogs(idOrName: string, tail = 100, filter = ''): LocalLogLine[] {
    const app =
      this.apps.get(idOrName) ||
      Array.from(this.apps.values()).find((a) => a.name === idOrName)
    if (!app) return []
    const lines = filter
      ? app.logs.filter((l) => l.content.toLowerCase().includes(filter.toLowerCase()))
      : app.logs
    return lines.slice(-tail)
  }

  serializeApp(app: LocalAppInstance) {
    const { uptimeSeconds, uptimeLabel } =
      app.state === 'running'
        ? formatProcessUptime(app.startedAt)
        : {
            uptimeSeconds: 0,
            uptimeLabel: app.lastExitCode !== null ? `Exited (${app.lastExitCode})` : 'Stopped',
          }
    const telemetry =
      app.state === 'running'
        ? samplePidResourceMetrics(app.pid)
        : { cpuPercent: 0, memoryBytes: 0, memoryMb: 0, memoryPercent: 0, threads: 0 }
    const commandPreview = `${path.basename(app.entryExecutable)} ${app.entryArgs.join(' ')}`.trim()
    return {
      id: app.id,
      name: app.name,
      image: app.runtimeLabel,
      runtime: app.runtime,
      runtimeLabel: app.runtimeLabel,
      source: 'local-app' as const,
      executable: app.entryExecutable,
      args: app.entryArgs,
      command: commandPreview,
      workingDir: app.appDir,
      state: app.state,
      status: app.state === 'running' ? `Up ${uptimeLabel}` : uptimeLabel,
      uptimeSeconds,
      uptimeLabel,
      cpuPercent: telemetry.cpuPercent,
      memoryBytes: telemetry.memoryBytes,
      memoryMb: telemetry.memoryMb,
      memoryPercent: telemetry.memoryPercent,
      threads: telemetry.threads,
      pid: app.pid,
      port: app.port,
      ports: [{ hostPort: app.port, containerPort: app.containerPort, protocol: 'tcp' }],
      appDir: app.appDir,
      liveUrl: `/live/${app.name}/`,
      repoUrl: app.repoUrl || null,
      branch: app.branch || null,
      commit: app.commit || null,
      created: app.created,
    }
  }
}
