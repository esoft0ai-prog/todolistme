# Camplo image (ADL D-7b): one image, two processes — the API/web server and the BullMQ worker.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY server ./server
RUN npm run vercel-build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production PORT=4173
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4173/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/dev.js"]
