FROM node:20-slim

# הגדרת אזור זמן לישראל
ENV TZ=Asia/Jerusalem

RUN apt-get update && apt-get install -y \
    chromium \
    build-essential \
    python3 \
    make \
    g++ \
    tzdata \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production && npm rebuild sqlite3 --build-from-source

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
