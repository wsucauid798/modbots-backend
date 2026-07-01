FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY modbots-backend/package.json ./modbots-backend/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY modbots-backend ./modbots-backend

RUN npm run build --workspace modbots-backend

FROM node:22-alpine AS production-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY modbots-backend/package.json ./modbots-backend/package.json
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/modbots-backend/dist ./modbots-backend/dist
COPY --from=production-deps /app/node_modules ./node_modules

EXPOSE 3001

CMD ["node", "modbots-backend/dist/server.js"]
