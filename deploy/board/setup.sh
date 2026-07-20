#!/usr/bin/env bash
# Bring up the self-hosted Executive Board backend (Postgres + PostgREST + nginx)
# and smoke-test a real INSERT + SELECT + DELETE through the PostgREST wire format
# that src/exec-comms.ts uses.
#
#   bash deploy/board/setup.sh          # up + verify
#   bash deploy/board/setup.sh --down   # tear the stack down
#   bash deploy/board/setup.sh --reset  # tear down AND wipe the pg volume, then up
#
# On success it prints the BOARD_DB_URL / BOARD_DB_KEY to add to Nova's .env.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/.env"
COMPOSE=(docker compose --project-name nova-board -f "$HERE/docker-compose.yml")

b64url() { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }

mint_jwt() {
  # HS256 JWT with a single {"role":"nova_board"} claim, signed with $1.
  local secret="$1"
  local header payload signing_input sig
  header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
  payload="$(printf '%s' '{"role":"nova_board"}' | b64url)"
  signing_input="${header}.${payload}"
  sig="$(printf '%s' "$signing_input" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)"
  printf '%s.%s' "$signing_input" "$sig"
}

if [[ "${1:-}" == "--down" ]]; then
  "${COMPOSE[@]}" down; exit 0
fi
if [[ "${1:-}" == "--reset" ]]; then
  "${COMPOSE[@]}" down -v
fi

echo "==> 1/6 Checking Docker daemon"
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable. Start Docker Desktop and retry." >&2
  exit 1
fi
docker version --format '    server {{.Server.Version}}'

echo "==> 2/6 Ensuring $ENV_FILE with generated secrets"
if [[ ! -f "$ENV_FILE" ]]; then
  PG_PW="$(openssl rand -hex 24)"
  AUTH_PW="$(openssl rand -hex 24)"
  JWT_SECRET="$(openssl rand -hex 32)"
  JWT="$(mint_jwt "$JWT_SECRET")"
  cat > "$ENV_FILE" <<EOF
POSTGRES_USER=nova
POSTGRES_DB=nova_board
POSTGRES_PASSWORD=$PG_PW
AUTHENTICATOR_PASSWORD=$AUTH_PW
PGRST_JWT_SECRET=$JWT_SECRET
BOARD_PROXY_PORT=3005
BOARD_DB_KEY=$JWT
EOF
  chmod 600 "$ENV_FILE"
  echo "    generated fresh secrets -> $ENV_FILE"
else
  echo "    reusing existing $ENV_FILE"
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
PORT="${BOARD_PROXY_PORT:-3005}"
BASE="http://localhost:${PORT}"

# If BOARD_DB_KEY is missing from an older .env, mint it from the secret.
if [[ -z "${BOARD_DB_KEY:-}" ]]; then
  BOARD_DB_KEY="$(mint_jwt "$PGRST_JWT_SECRET")"
  echo "BOARD_DB_KEY=$BOARD_DB_KEY" >> "$ENV_FILE"
fi

echo "==> 3/6 Starting stack (compose up -d)"
"${COMPOSE[@]}" --env-file "$ENV_FILE" up -d

echo "==> 4/6 Waiting for the proxy + PostgREST to answer"
for i in $(seq 1 40); do
  if curl -fsS "$BASE/health" >/dev/null 2>&1; then break; fi
  sleep 1
  [[ $i -eq 40 ]] && { echo "proxy did not come up" >&2; "${COMPOSE[@]}" logs --tail 30; exit 1; }
done
AUTH=(-H "apikey: $BOARD_DB_KEY" -H "Authorization: Bearer $BOARD_DB_KEY" -H "Content-Type: application/json")
for i in $(seq 1 40); do
  if curl -fsS "${AUTH[@]}" "$BASE/rest/v1/proactive_runs?limit=1" >/dev/null 2>&1; then break; fi
  sleep 1
  [[ $i -eq 40 ]] && { echo "PostgREST not ready" >&2; "${COMPOSE[@]}" logs postgrest --tail 40; exit 1; }
done

echo "==> 5/6 Smoke test: INSERT + SELECT + DELETE via /rest/v1 (exec-comms wire format)"
PROBE="setup-probe-$(date +%s)-$$"
INS="$(curl -fsS "${AUTH[@]}" -H "Prefer: return=representation" \
  -X POST "$BASE/rest/v1/proactive_runs" \
  -d "{\"role\":\"setup\",\"source\":\"smoke\",\"source_id\":\"$PROBE\"}")"
echo "$INS" | grep -q "$PROBE" || { echo "INSERT did not echo probe row: $INS" >&2; exit 1; }
SEL="$(curl -fsS "${AUTH[@]}" "$BASE/rest/v1/proactive_runs?source_id=eq.$PROBE&select=id,role,source_id")"
echo "$SEL" | grep -q "$PROBE" || { echo "SELECT did not return probe row: $SEL" >&2; exit 1; }
curl -fsS "${AUTH[@]}" -X DELETE "$BASE/rest/v1/proactive_runs?source_id=eq.$PROBE" >/dev/null
echo "    INSERT + SELECT + DELETE round-trip OK"

echo "==> 6/6 Done"
echo
echo "board backend E2E PASSED"
echo
echo "Add to Nova's .env:"
echo "  BOARD_DB_URL=$BASE"
echo "  BOARD_DB_KEY=$BOARD_DB_KEY"
