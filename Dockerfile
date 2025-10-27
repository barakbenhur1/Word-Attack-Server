# ---------- builder ----------
FROM node:20-slim AS builder
WORKDIR /app

# system deps (small) – libgomp1 helps with onnxruntime native CPU kernels
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 && \
    rm -rf /var/lib/apt/lists/*

# only copy manifests for caching
COPY package*.json ./

# reproducible install
RUN npm ci --omit=dev

# copy app src
COPY . .

# ---------- runner ----------
FROM node:20-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 && \
    rm -rf /var/lib/apt/lists/*

# copy deps and app from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app ./

# environment defaults (can be overridden in Render)
ENV NODE_ENV=production
ENV PORT=3000

# Keep Node heap modest so we don't spike over 512 MB
ENV NODE_OPTIONS=--max-old-space-size=420

# A few knobs we rely on in your ai.js
# - auto: load from disk if present, else download to RAM; we’ll download to /tmp
ENV MODEL_LOAD_MODE=auto
ENV MODEL_DIR=/tmp/models

# Use native backend by default
ENV ORT_FORCE_WASM=0
ENV ORT_WASM_THREADS=1
ENV AI_MAX_CONCURRENCY=1
ENV MAX_TOKENS=64

EXPOSE 3000
CMD ["node", "app.js"]
