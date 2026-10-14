#!/usr/bin/env bash
# Build and start this checkout without requiring Node, Python or npm on the host.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -gt 0 ]]; then
  echo 'Usage: ./scripts/start.sh (configure the port in .env with GATE_PORT)' >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo 'Install Docker with Docker Compose, then run this command again.' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'Start Docker Desktop or the Docker daemon, then try again.' >&2
  exit 1
fi
if [[ ! -e .env ]]; then
  (umask 077; set -o noclobber; cat .env.example > .env)
  echo 'Created private .env defaults. Change GATE_PORT there to use another port.'
fi
docker compose config --quiet
docker compose up --build --detach --wait --wait-timeout 120
binding="$(docker compose port relay 4310)"
echo
echo "GATE is ready at http://${binding}. Create your owner account in the browser."
echo 'Settings: .env | Logs: docker compose logs -f relay | Stop: docker compose down'
echo 'Data survives restarts. Never use docker compose down -v unless deleting all data.'
