FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tailwind.config.cjs ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=production-deps /app/node_modules ./node_modules

EXPOSE 3003

CMD ["node", "dist/server.js"]
