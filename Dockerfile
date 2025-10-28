# syntax=docker/dockerfile:1

# ---- build stage ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
# use lockfile when present
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
# verify native ORT resolves at build time (optional)
RUN node -e "require('onnxruntime-node'); console.log('onnxruntime-node OK')"

# ---- runtime ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# minimal deps for onnxruntime-node + health
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tini libstdc++6 libgomp1 libatomic1 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# DO NOT hardcode PORT on Render; it injects $PORT. Your app should use process.env.PORT || 3000.
# ENV PORT=3000   # (leave this out)

# conservative defaults for Free plan
ENV AI_MAX_CONCURRENCY=1 \
    MAX_TOKENS=48 \
    ORT_FORCE_WASM=0 \
    NODE_OPTIONS="--max-old-space-size=420" \
    MODEL_LOAD_MODE=auto \
    MODEL_DIR=/models \
    MODEL_NAME=wordzap.onnx \
    TOKENIZER_NAME=tokenizer.json

# optional persistent disk (if you enable one in Render)
VOLUME ["/models"]

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# tiny init to reap zombies
ENTRYPOINT ["/usr/bin/tini","--"]

# healthcheck (Render also has its own, but this helps locally)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

EXPOSE 3000
CMD ["node","app.js"]
