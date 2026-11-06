# Merkez (hub): cihazlarin token sepetlerini ve kota orneklerini birlestirir, paneli sunar.
# Derleme baglami depo kokudur (docker-compose.yml). Electron ikilisi indirilmez.
FROM node:24-alpine AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
# Kurulum betikleri calismaz: Electron'un indirme betigi gereksiz, esbuild platform paketi zaten gelir.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npx esbuild server/src/index.ts --bundle --platform=node --format=esm --target=node24 \
      --external:node:sqlite --outfile=/out/server.mjs \
 && npm run build:panel \
 && mkdir -p /out && cp -r out/panel /out/panel

FROM node:24-alpine
WORKDIR /app
COPY --from=build /out/server.mjs ./server.mjs
COPY --from=build /out/panel ./panel
ENV NODE_ENV=production HUB_DATA=/data HUB_PANEL_DIR=/app/panel
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8081/health >/dev/null || exit 1
CMD ["node", "--no-warnings", "server.mjs"]
