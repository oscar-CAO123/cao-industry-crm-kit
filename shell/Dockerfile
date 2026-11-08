# The CRM shell image. Build from the kit repo root:  docker build -f shell/Dockerfile -t crm-shell .
# One image runs everywhere: the web app (default command), any workflow cron, and the schema apply.
# The only secret the host gives it is OP_SERVICE_ACCOUNT_TOKEN; every other key is read from 1Password at start.
FROM node:22.18-slim AS build
WORKDIR /kit
COPY . .
WORKDIR /kit/shell
RUN corepack enable && pnpm install --no-frozen-lockfile && DATABASE_URL=postgresql://placeholder:5432/build pnpm build

FROM node:22.18-slim
ENV NODE_ENV=production KIT_ROOT=/kit PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /kit
COPY --from=build /kit/shell/.next/standalone ./
COPY --from=build /kit/shell/.next/static ./shell/.next/static
COPY --from=build /kit/shell/public ./shell/public
COPY --from=build /kit/industries ./industries
COPY --from=build /kit/core ./core
COPY --from=build /kit/tools/workflow.ts ./tools/workflow.ts
COPY --from=build /kit/shell/workflows ./shell/workflows
COPY --from=build /kit/shell/scripts ./shell/scripts
COPY --from=build /kit/shell/db ./shell/db
COPY --from=build /kit/shell/settings ./shell/settings
COPY --from=build /kit/shell/lib/db-ssl.ts ./shell/lib/db-ssl.ts
COPY --from=build /kit/shell/secrets.refs.json* ./shell/
USER node
EXPOSE 3000
ENTRYPOINT ["node", "shell/scripts/with-secrets.mjs", "--"]
CMD ["node", "shell/server.js"]
