FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV SIREN_WEB_HOST=0.0.0.0
ENV SIREN_WEB_PORT=4173
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/web-server.mjs ./scripts/web-server.mjs
COPY --from=build /app/scripts/official-proxy.mjs ./scripts/official-proxy.mjs
COPY --from=build /app/scripts/proxy-stream.mjs ./scripts/proxy-stream.mjs
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/web-server.mjs"]
