# The CRM shell demo: a static site built from the industry templates, served by a small Node file server.
# Build from the kit repo root:  docker build -f demo/Dockerfile -t crm-shell-demo .
# It holds no keys and no database. Set DEMO_FRAME_ANCESTORS to the origin(s) allowed to show it in a frame.
FROM node:22.18-slim AS build
WORKDIR /kit
COPY industries ./industries
COPY demo ./demo
RUN node demo/build.mjs

FROM node:22.18-slim
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /demo
COPY --from=build /kit/demo/dist ./dist
COPY --from=build /kit/demo/server.mjs ./server.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
