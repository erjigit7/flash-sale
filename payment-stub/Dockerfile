FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# платежи заглушки живут на диске (в compose — volume stubdata), рестарт их не теряет
ENV DATA_FILE=/data/payments.json
RUN mkdir -p /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
EXPOSE 4000
# Node 24 исполняет TypeScript напрямую (type stripping), сборка не нужна
CMD ["node", "src/server.ts"]
