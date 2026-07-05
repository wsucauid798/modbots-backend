FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY modbots-backend/package.json ./modbots-backend/package.json
COPY modbots-backend/chat-bot-runtime/package.json ./modbots-backend/chat-bot-runtime/package.json
RUN npm ci

COPY modbots-backend/chat-bot-runtime ./modbots-backend/chat-bot-runtime
RUN npm run build --workspace modbots-backend/chat-bot-runtime

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/modbots-backend/chat-bot-runtime/dist ./dist

CMD ["node", "dist/index.js"]
