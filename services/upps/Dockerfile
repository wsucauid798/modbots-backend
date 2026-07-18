FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/account/package.json ./services/account/package.json
COPY services/api/package.json ./services/api/package.json
COPY services/runtime/package.json ./services/runtime/package.json
COPY services/upps/package.json ./services/upps/package.json
RUN npm ci

COPY services/upps ./services/upps
RUN npm run build --workspace modbots-upps

FROM node:22-alpine AS production-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/account/package.json ./services/account/package.json
COPY services/api/package.json ./services/api/package.json
COPY services/runtime/package.json ./services/runtime/package.json
COPY services/upps/package.json ./services/upps/package.json
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app/services/upps
ENV NODE_ENV=production

COPY --from=build /app/services/upps/package.json ./
COPY --from=build /app/services/upps/dist ./dist
COPY --from=build /app/services/upps/public ./public
COPY --from=production-deps /app/node_modules /app/node_modules

EXPOSE 3010
CMD ["node", "dist/server.js"]
