# Remote Quiva MCP. Build context is the mcp repo root:
#   docker build -f quiva-mcp-remote/Dockerfile -t quiva-mcp-remote .
# Dockerfile.dockerignore allowlists package manifests, src/ and examples/ only.
FROM node:22-slim

ENV NODE_ENV=production PORT=8080
WORKDIR /app

COPY . .
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "quiva-mcp-remote/src/server.js"]
