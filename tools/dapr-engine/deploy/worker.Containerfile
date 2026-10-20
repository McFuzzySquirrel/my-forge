# Forge worker image: the pinned Node runtime plus Git, which the execution
# host needs to prepare isolated workspaces and integrate checkpoints.
# Harness CLIs and their credentials are intentionally not installed.
FROM docker.io/library/node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
