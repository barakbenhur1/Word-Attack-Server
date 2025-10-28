# ---- build stage ----
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
# Optional: verify native ORT is installable in build image (won't run here)
RUN node -e "try{require('onnxruntime-node');console.log('onnxruntime-node OK')}catch(e){console.log('skip')}"
COPY . .

# ---- runtime ----
FROM node:20-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=builder /app ./

# run as non-root for safety
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

# Render env (tuned for low memory)
ENV AI_MAX_CONCURRENCY=1
ENV MAX_TOKENS=48
ENV MODEL_LOAD_MODE=disk
ENV MODEL_DIR=/app/models
ENV MODEL_NAME=wordzap.int8.onnx
# Prefer native ORT + mmap; if still OOM, try ORT_FORCE_WASM=1 instead
ENV ORT_FORCE_WASM=0
ENV NODE_OPTIONS=--max-old-space-size=384

EXPOSE 3000
CMD ["node", "app.js"]
