# Minimal image for directory checks (Glama) and for running the stdio server
# without a local Node install. The server starts without credentials: `login`
# is a tool, so tools/list works before any key exists.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV BRIEFGATE_NO_BROWSER=1
ENTRYPOINT ["node", "dist/index.js"]
