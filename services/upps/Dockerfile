FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY modbots-backend/services/account/package.json ./modbots-backend/services/account/package.json
COPY modbots-backend/services/api/package.json ./modbots-backend/services/api/package.json
COPY modbots-backend/services/runtime/package.json ./modbots-backend/services/runtime/package.json
COPY modbots-backend/services/upps/package.json ./modbots-backend/services/upps/package.json
RUN npm ci

COPY modbots-backend/services/upps ./modbots-backend/services/upps
RUN npm run build --workspace modbots-upps

FROM node:22-alpine AS production-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY modbots-backend/services/account/package.json ./modbots-backend/services/account/package.json
COPY modbots-backend/services/api/package.json ./modbots-backend/services/api/package.json
COPY modbots-backend/services/runtime/package.json ./modbots-backend/services/runtime/package.json
COPY modbots-backend/services/upps/package.json ./modbots-backend/services/upps/package.json
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app/modbots-backend/services/upps
ENV NODE_ENV=production

COPY --from=build /app/modbots-backend/services/upps/package.json ./
COPY --from=build /app/modbots-backend/services/upps/dist ./dist
COPY --from=build /app/modbots-backend/services/upps/public ./public
COPY --from=production-deps /app/node_modules /app/node_modules

EXPOSE 3010
CMD ["node", "dist/server.js"]
