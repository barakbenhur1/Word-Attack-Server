# ---- Base ----
FROM node:20-slim

# Optional: keep image minimal and TLS happy
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Dependencies layer (use lockfile for reproducible builds) ----
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- App layer ----
COPY . .

# Runtime envs (safe defaults; override in Render dashboard)
ENV NODE_ENV=production \
    # keep Node heap modest so WASM/ORT has room in 512MB instances
    NODE_OPTIONS="--max-old-space-size=384" \
    ORT_WASM_THREADS=1 \
    MODEL_LOAD_MODE=memory \
    MAX_TOKENS=48

# Render maps PORT for you; your code already reads process.env.PORT
EXPOSE 3000

# Use tini as PID 1 (handles signals / clean shutdowns)
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the server
CMD ["node", "app.js"]
