# ---- build stage ----
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# No lockfile in context -> npm install
RUN npm install --omit=dev

# Make sure native ORT resolves (optional but nice)
RUN node -e "require('onnxruntime-node'); console.log('onnxruntime-node OK')"

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
EXPOSE 3000

# Keep memory low
ENV AI_MAX_CONCURRENCY=1
ENV MAX_TOKENS=48
ENV ORT_FORCE_WASM=0
ENV NODE_OPTIONS=--max-old-space-size=420

CMD ["node", "app.js"]
