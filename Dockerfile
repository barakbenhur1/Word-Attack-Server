# ---- build stage ----
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# Use lockfile if present; otherwise fallback (avoids npm ci error)
RUN [ -f package-lock.json ] && npm ci --omit=dev || npm install --omit=dev

# Fail fast if native ORT can't load (ensures we don't fall back to WASM silently)
RUN node -e "require('onnxruntime-node'); console.log('onnxruntime-node OK')"

COPY . .

# ---- runtime stage ----
FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 3000

# keep RAM tight
ENV AI_MAX_CONCURRENCY=1
ENV MAX_TOKENS=48
ENV ORT_FORCE_WASM=0
ENV NODE_OPTIONS=--max-old-space-size=420

CMD ["node", "app.js"]
