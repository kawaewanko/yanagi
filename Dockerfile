FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci

COPY . .
RUN npm run build
RUN find apps packages -type d -name src -prune -exec rm -rf {} + \
    && find apps packages -type f \( -name 'tsconfig*.json' -o -name '*.test.*' \) -delete

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --omit=dev
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/database/migrations ./database/migrations

EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@yanagi/core-api"]
