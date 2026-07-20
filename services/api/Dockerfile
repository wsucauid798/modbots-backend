FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/api/package.json ./services/api/package.json
COPY services/runtime/package.json ./services/runtime/package.json
COPY services/upps/package.json ./services/upps/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY services/api ./services/api

RUN npm run build --workspace modbots-backend

FROM node:22-alpine AS production-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/api/package.json ./services/api/package.json
COPY services/runtime/package.json ./services/runtime/package.json
COPY services/upps/package.json ./services/upps/package.json
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/services/api/dist ./services/api/dist
COPY --from=production-deps /app/node_modules ./node_modules

EXPOSE 3001

CMD ["node", "services/api/dist/server.js"]
