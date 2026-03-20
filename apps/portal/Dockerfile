FROM node:20-slim AS base
RUN corepack enable

FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune @compound-security/portal --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# Copy files not included in turbo prune output
COPY --from=pruner /app/vendor ./vendor
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
# Copy config file (required at build time for API route collection)
COPY --from=pruner /app/compound-config.json* ./
# Copy snapshots directory if it exists (shared between CLI and portal)
COPY --from=pruner /app/.snapshot[s] ./.snapshots/
RUN pnpm turbo build --filter=@compound-security/portal

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/portal/public ./apps/portal/public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Create cache directory for contract name cache
# Note: Code resolves monorepo root as "../.." from /app, which equals /
# So we create both /app/.cache and /.cache as a workaround
RUN mkdir -p .cache
RUN chown -R nextjs:nodejs .cache
RUN mkdir -p /.cache
RUN chown -R nextjs:nodejs /.cache

# Create snapshots directory with correct permissions
# Note: Code resolves monorepo root as "../.." from /app, which equals /
# So we create both /app/.snapshots and /.snapshots as a workaround
RUN mkdir -p .snapshots
RUN chown -R nextjs:nodejs .snapshots
RUN mkdir -p /.snapshots
RUN chown -R nextjs:nodejs /.snapshots

# Create tenderly testnets file with correct permissions
# The simulator writes testnet RPC URLs here after creating virtual testnets
RUN echo '{}' > .tenderly-testnets.json && chown nextjs:nodejs .tenderly-testnets.json

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/apps/portal/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/portal/.next/static ./apps/portal/.next/static

# Copy vendor for decoder runtime access
COPY --from=builder /app/vendor ./vendor
# Copy config files for runtime access (needs write permission for /config page)
COPY --from=builder --chown=nextjs:nodejs /app/compound-config.json* ./
# Copy snapshots directory for runtime access (shared between CLI and portal)
COPY --from=builder /app/.snapshot[s] ./.snapshots/

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/portal/server.js"]
