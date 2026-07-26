#!/bin/sh
set -eu

: "${MODBOTS_IMAGE_TAG:?Set MODBOTS_IMAGE_TAG before running production deploy.}"

if [ "${MODBOTS_DEPLOY_SOURCE:-}" != "github-actions" ]; then
  echo "Production deploys must run through GitHub CI."
  exit 1
fi

if [ ! -f .env ]; then
  echo "Missing .env in $(pwd). Create it on the server before deploying."
  exit 1
fi

for variable in \
  PRODUCTION_POSTGRES_PASSWORD \
  PRODUCTION_S3_ACCESS_KEY \
  PRODUCTION_S3_SECRET_KEY \
  PRODUCTION_COOKIE_SECRET \
  PRODUCTION_WEB_ORIGINS \
  PRODUCTION_WEB_REDIRECT_URI; do
  if ! grep -Eq "^${variable}=.+" .env; then
    echo "Missing required ${variable} in $(pwd)/.env."
    exit 1
  fi
done

docker network inspect modbots >/dev/null 2>&1 || docker network create modbots
docker compose --env-file .env -f docker-compose.prod.yml pull

# Model Runner refuses configuration while a model is active. Stop both model
# consumers, and restart the existing services if deployment exits early.
restart_model_consumers() {
  docker compose --env-file .env -f docker-compose.prod.yml start ml runtime \
    >/dev/null 2>&1 || true
}

trap restart_model_consumers EXIT
docker compose --env-file .env -f docker-compose.prod.yml stop runtime ml
docker model unload --all

for attempt in $(seq 1 30); do
  if [ -z "$(docker model ps | sed -n '2p')" ]; then
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    echo "The model did not unload before reconfiguration."
    docker model ps || true
    exit 1
  fi

  sleep 1
done

docker compose --env-file .env -f docker-compose.prod.yml up -d --remove-orphans
trap - EXIT

echo "Waiting for production API..."
for attempt in $(seq 1 60); do
  if docker compose --env-file .env -f docker-compose.prod.yml exec -T api \
    node -e "fetch('http://localhost:' + (process.env.PORT || '3001') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    break
  fi

  if [ "$attempt" -eq 60 ]; then
    echo "Production API did not become healthy."
    exit 1
  fi

  sleep 2
done

docker compose --env-file .env -f docker-compose.prod.yml exec -T api \
  sh -c 'MODBOTS_API_URL="http://localhost:${PORT:-3001}" MODBOTS_ROOM_ID="${MODBOTS_ROOM_ID:-global-lobby}" node scripts/seed-bots.mjs'

if [ -f production-data-guard.sql ]; then
  docker compose --env-file .env -f docker-compose.prod.yml exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-modbots}" -d "${POSTGRES_DB:-modbots}" \
    < production-data-guard.sql
else
  echo "Missing production-data-guard.sql in $(pwd)."
  exit 1
fi
docker compose --env-file .env -f docker-compose.prod.yml ps
