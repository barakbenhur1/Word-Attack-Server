# ---- build stage ----
FROM node:20-slim AS builder

# ✅ Avoid debconf trying to use ReadLine
ARG DEBIAN_FRONTEND=noninteractive
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 libstdc++6 libatomic1 apt-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Optional sanity check (skip if you don't ship onnxruntime-node)
RUN node -e "try{require('onnxruntime-node');console.log('onnxruntime-node OK')}catch(e){console.log('skip')}" || true

COPY . .

# ---- runtime ----
FROM node:20-slim AS runner

# ✅ Noninteractive again here
ARG DEBIAN_FRONTEND=noninteractive
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 libstdc++6 libatomic1 apt-utils \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 3000

# Inference knobs
ENV AI_MAX_CONCURRENCY=1
ENV MAX_TOKENS=48
ENV ORT_FORCE_WASM=0
ENV NODE_OPTIONS=--max-old-space-size=420

CMD ["node", "app.js"]
