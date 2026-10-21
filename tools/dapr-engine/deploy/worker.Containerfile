# Forge worker image: the pinned Node runtime plus Git, which the execution
# host needs to prepare isolated workspaces and integrate checkpoints, and the
# pinned harness CLIs the worker may run. Credentials are never baked in: the
# launcher mounts an operator-managed grant file read-only at runtime.
FROM docker.io/library/node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates util-linux \
  && rm -rf /var/lib/apt/lists/*
# Bump the compose image tag whenever these pins change so installs rebuild.
RUN npm install --global --no-fund --no-audit \
    @github/copilot@1.0.100 \
    @anthropic-ai/claude-code@2.1.304 \
    @opencode/cli@2.0.32 \
  && npm cache clean --force
