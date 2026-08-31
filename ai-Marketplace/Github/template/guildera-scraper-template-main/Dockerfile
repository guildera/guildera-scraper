FROM mcr.microsoft.com/playwright:v1.45.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY scraper.js .

CMD ["node", "scraper.js"]
