FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY modbots-backend/services/api/package.json ./modbots-backend/services/api/package.json
COPY modbots-backend/services/runtime/package.json ./modbots-backend/services/runtime/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY modbots-backend/services/api ./modbots-backend/services/api

RUN npm run build --workspace modbots-backend

FROM node:22-alpine AS production-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY modbots-backend/services/api/package.json ./modbots-backend/services/api/package.json
COPY modbots-backend/services/runtime/package.json ./modbots-backend/services/runtime/package.json
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/modbots-backend/services/api/dist ./modbots-backend/services/api/dist
COPY --from=production-deps /app/node_modules ./node_modules

EXPOSE 3001

CMD ["node", "modbots-backend/services/api/dist/server.js"]
