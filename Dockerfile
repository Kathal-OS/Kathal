# ---- Build stage ----
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
COPY web/package*.json web/
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:22-alpine

RUN apk add --no-cache git python3 py3-pip ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/web/package*.json web/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/deploy ./deploy
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/.env.example ./.env.example

RUN mkdir -p /data /data/apps
VOLUME /data

ENV NODE_ENV=production
ENV PORT=3000
ENV KATHAL_DATA_DIR=/data
ENV KATHAL_APPS_DIR=/data/apps

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["./node_modules/.bin/tsx", "server.ts"]
