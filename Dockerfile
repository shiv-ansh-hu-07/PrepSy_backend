# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:22-alpine AS build
# Prisma needs openssl present to detect the correct query engine on Alpine.
RUN apk add --no-cache openssl
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# `npm run build` runs `prisma generate && nest build`, producing dist/main.js
RUN npm run build

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Prisma schema + migrations are needed at runtime for the generated client
# and for `prisma migrate deploy`.
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist

# Run as the built-in non-root user for a smaller blast radius.
USER node

EXPOSE 5000
CMD ["node", "dist/main.js"]
