# ---- build ----
FROM node:20-slim AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# ---- runtime ----
FROM node:20-slim AS runner
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# tiny runtime footprint
ENV AI_MAX_CONCURRENCY=1
ENV MAX_TOKENS=48
ENV ORT_FORCE_WASM=0
ENV NODE_OPTIONS=--max-old-space-size=256

# copy built app
COPY --from=builder /app ./
EXPOSE 3000
CMD ["node", "app.js"]
