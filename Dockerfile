# Dockerfile
FROM node:20-slim

# keep memory modest on small instances
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# Copy ONLY manifests first for layer caching
COPY package.json package-lock.json ./

# Reproducible install
RUN npm ci --omit=dev --no-audit --no-fund

# Now copy the rest of the app
COPY . .

EXPOSE 3000
CMD ["node", "app.js"]
