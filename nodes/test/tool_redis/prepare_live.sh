#!/bin/sh
# Generate a short-lived CA/certificate for disposable local fixtures only.
set -eu
fixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$fixture_dir/.certs"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$fixture_dir/.certs/server.key" -out "$fixture_dir/.certs/server.crt" \
  -days 2 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost'
# The unprivileged container must read this disposable test key.
chmod 644 "$fixture_dir/.certs/server.key"
# Recreate so a rerun loads the newly generated certificate.
docker compose -p rocketride-redis-v1 -f "$fixture_dir/compose.yaml" up -d --wait --force-recreate
