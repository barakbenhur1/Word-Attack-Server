FROM node:20-slim

WORKDIR /app

# copy only manifests first for better layer caching
COPY package*.json ./

# reproducible install using the lockfile
RUN npm ci --omit=dev --no-audit --no-fund

# now copy the rest of the app
COPY . .

ENV NODE_ENV=production
# Render will set PORT for you; your app already uses process.env.PORT
EXPOSE 3000

CMD ["node", "app.js"]
