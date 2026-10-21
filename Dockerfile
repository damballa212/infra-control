FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vitest.config.ts ./
COPY server ./server
COPY tests ./tests
COPY ops/fiberhome ./ops/fiberhome
COPY design/handoff/checks ./design/handoff/checks
RUN npm run build && npm test -- --maxWorkers=2 --testTimeout=15000

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS ui
WORKDIR /app/design/handoff
COPY design/handoff/package.json design/handoff/package-lock.json ./
RUN npm ci
COPY design/handoff ./
COPY contracts /app/contracts
RUN npm run build

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ENV NODE_ENV=production PORT=17600 DATA_DIR=/data CONFIG_PATH=/run/secrets/config.json WEB_ROOT=/app/public
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=ui /app/design/handoff/dist ./public
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 17600
# SQLite quotas and job recovery require exactly one process owning the volume.
# flock also excludes overlapping containers during a Coolify redeployment.
ENTRYPOINT ["flock", "--exclusive", "--nonblock", "--no-fork", "/data/instance.lock", "node", "dist/server/index.js"]
