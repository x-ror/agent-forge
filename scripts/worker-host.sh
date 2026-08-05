#!/bin/sh
# Run the AgentForge worker on the host (foreground) — systemd-free variant.
cd "$(dirname "$0")/../apps/server" || exit 1
AGENTFORGE_ENV_FILE="$(pwd)/../../.env.worker-host" exec node dist/main.worker.js
