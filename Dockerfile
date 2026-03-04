FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc

COPY admin/package.json admin/
RUN cd admin && npm install

COPY admin/ admin/
RUN cd admin && npm run build

COPY migrations/ migrations/

FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/admin/dist/ admin/dist/
COPY --from=builder /app/migrations/ migrations/

ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
