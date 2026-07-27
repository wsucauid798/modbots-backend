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

if [ -z "${MODEL_ID:-}" ]; then
  echo "Missing required MODEL_ID in the deployment environment."
  exit 1
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "Missing required OPENAI_API_KEY in the deployment environment."
  exit 1
fi

if [ -z "${UPPS_SERVICE_TOKEN:-}" ]; then
  echo "Missing required UPPS_SERVICE_TOKEN in the deployment environment."
  exit 1
fi

docker network inspect modbots >/dev/null 2>&1 || docker network create modbots
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d --remove-orphans

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

echo "Verifying production profile-picture storage..."
docker compose --env-file .env -f docker-compose.prod.yml exec -T api \
  node -e "const baseUrl = 'http://upps:3010'; const headers = { authorization: 'Bearer ' + process.env.UPPS_SERVICE_TOKEN, 'content-type': 'application/json' }; let profilePictureId; fetch(baseUrl + '/internal/profile-pictures', { method: 'POST', headers, body: JSON.stringify({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' }) }).then(async (response) => { if (!response.ok) throw new Error('Upload failed with HTTP ' + response.status); profilePictureId = (await response.json()).profilePictureId; const served = await fetch(baseUrl + '/profile-pictures/' + profilePictureId); if (!served.ok) throw new Error('Read failed with HTTP ' + served.status); const removed = await fetch(baseUrl + '/internal/profile-pictures/' + profilePictureId, { method: 'DELETE', headers: { authorization: headers.authorization } }); if (!removed.ok) throw new Error('Cleanup failed with HTTP ' + removed.status); }).catch((error) => { console.error(error.message); process.exit(1); });"

echo "Waiting for production inference..."
for attempt in $(seq 1 60); do
  if docker compose --env-file .env -f docker-compose.prod.yml exec -T ml \
    python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=10)"; then
    break
  fi

  if [ "$attempt" -eq 60 ]; then
    echo "Production inference did not become healthy."
    docker compose --env-file .env -f docker-compose.prod.yml logs --tail 100 ml
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
