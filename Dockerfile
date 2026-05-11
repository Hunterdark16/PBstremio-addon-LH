FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7860
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./

RUN npm install --omit=dev --no-audit --no-fund --loglevel=warn \
  && node -e "require.resolve('stremio-addon-sdk'); require.resolve('express'); require.resolve('node-fetch'); require.resolve('cheerio'); require.resolve('https-proxy-agent'); console.log('dependencies ok')" \
  && npm cache clean --force

COPY addon.js ./

EXPOSE 7860

CMD ["npm", "start"]
