# Официальный образ Playwright: браузеры уже внутри, ставить локально ничего не нужно
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /e2e
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
CMD ["npx", "playwright", "test"]
