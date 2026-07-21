#!/bin/sh
set -eu

: "${MODBOTS_IMAGE_TAG:?Set MODBOTS_IMAGE_TAG before running production deploy.}"

if [ ! -f .env ]; then
  echo "Missing .env in $(pwd). Create it on the server before deploying."
  exit 1
fi

for variable in POSTGRES_PASSWORD S3_ACCESS_KEY S3_SECRET_KEY COOKIE_SECRET; do
  if ! grep -Eq "^${variable}=.+" .env; then
    echo "Missing required ${variable} in $(pwd)/.env."
    exit 1
  fi
done

docker compose --env-file .env pull
docker compose --env-file .env up -d --remove-orphans
docker compose --env-file .env ps
