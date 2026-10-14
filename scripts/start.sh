#!/usr/bin/env bash
# Build and start this checkout without requiring Node, Python or npm on the host.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -gt 1 || ( $# -eq 1 && $1 != --postgres ) ]]; then
  echo 'Usage: ./scripts/start.sh [--postgres] (configure GATE_PORT in the selected env file)' >&2
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
compose=(docker compose)
settings=.env
if [[ ${1:-} == --postgres ]]; then
  settings=.env.postgres
  compose+=(--env-file .env.postgres -f compose.postgres.yaml)
  if [[ ! -e $settings ]]; then
    # Hex characters are URL-safe. No Node, Python or cloud account is needed.
    database_password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ ${#database_password} -eq 64 ]] || { echo 'Password generation failed.' >&2; exit 1; }
    (umask 077; set -o noclobber; sed "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$database_password/" .env.postgres.example > "$settings")
    unset database_password
    echo 'Created private .env.postgres with a generated database password.'
  fi
elif [[ ! -e .env ]]; then
  (umask 077; set -o noclobber; cat .env.example > .env)
  echo 'Created private .env defaults. Change GATE_PORT there to use another port.'
fi
"${compose[@]}" config --quiet
"${compose[@]}" up --build --detach --wait --wait-timeout 120
binding="$("${compose[@]}" port relay 4310)"
echo
echo "GATE is ready at http://${binding}. Create your owner account in the browser."
echo "Settings: $settings"
echo "Logs: ${compose[*]} logs -f relay | Stop: ${compose[*]} down"
echo 'Data survives restarts. Never use docker compose down -v unless deleting all data.'
