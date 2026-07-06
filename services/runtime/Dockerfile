FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY modbots-backend/services/api/package.json ./modbots-backend/services/api/package.json
COPY modbots-backend/services/runtime/package.json ./modbots-backend/services/runtime/package.json
RUN npm ci

COPY modbots-backend/services/runtime ./modbots-backend/services/runtime
RUN npm run build --workspace modbots-chat-bot-runtime

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/modbots-backend/services/runtime/dist ./dist

CMD ["node", "dist/index.js"]
