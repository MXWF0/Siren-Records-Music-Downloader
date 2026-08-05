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
EXPOSE 4173
CMD ["node", "scripts/web-server.mjs"]
