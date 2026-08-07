# syntax=docker/dockerfile:1

# Ein Image, zwei Rollen: `next start` (App) und `node dist/worker/main.js`
# (Versand-Worker). Beide brauchen den Prisma-Client, daher ein gemeinsames
# Image mit Produktions-node_modules.

# ------------------------------------------------------------------ deps
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall ruft `prisma generate` - dafür muss prisma/ schon da sein.
RUN npm ci

# ----------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Platzhalter nur für den Build - zur Laufzeit kommen die echten Werte per env.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV SESSION_SECRET="build-time-placeholder-value-not-used-at-runtime"
ENV FIELD_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --------------------------------------------------------------- runtime
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Produktions-Abhängigkeiten (inkl. generiertem Prisma-Client).
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "next", "start"]
