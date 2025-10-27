FROM node:20-slim
WORKDIR /app

# install prod deps (works with or without lockfile)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund ; \
    else \
      npm install --omit=dev --no-audit --no-fund ; \
    fi

COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "app.js"]