FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
ENV NODE_ENV=production TZ=America/Santiago ESTADO_RUTA=/datos/estado.sqlite PUERTO=8080
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /datos && chown node:node /datos
USER node
VOLUME ["/datos"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/salud || exit 1
CMD ["node", "dist/index.js"]
