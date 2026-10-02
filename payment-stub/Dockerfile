FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
EXPOSE 4000
# Node 24 исполняет TypeScript напрямую (type stripping), сборка не нужна
CMD ["node", "src/server.ts"]
