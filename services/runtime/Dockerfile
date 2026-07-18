FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/api/package.json ./services/api/package.json
COPY services/runtime/package.json ./services/runtime/package.json
COPY services/upps/package.json ./services/upps/package.json
RUN npm ci

COPY services/runtime ./services/runtime
RUN npm run build --workspace modbots-chat-bot-runtime

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV RUNTIME_EXPERIENCE_DIR=/data/runtime

COPY --from=build /app/services/runtime/dist ./dist

CMD ["node", "dist/index.js"]
