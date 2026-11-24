FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production GATEWAY_PORT=8789
# Runtime uses only Node built-ins. Explicit copies exclude user credentials.
COPY gateway.mjs keys.mjs config.mjs upstream-pool.mjs ./
USER node
EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8789)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "gateway.mjs"]
