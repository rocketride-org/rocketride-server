#!/usr/bin/env bash
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
#
# Start a TLS-only PostgreSQL for the RocketRide cloud-database TLS and
# isolation tests (nodes/test/test_rocketride_db_{tls,isolation}_full.py).
#
#   start-pg-tls.sh [container-name] [host-port] [output-dir]
#
# * server certificate: throwaway CA minted here with the openssl command,
#   names "localhost" ONLY (so 127.0.0.1 is a real host-name mismatch)
# * every non-TLS connection is rejected by pg_hba.conf (hostnossl reject)
# * databases: rrtenant (rruser) plus two synthetic tenants, t_orga/r_orga and
#   t_orgb/r_orgb, with fixed synthetic passwords for the throwaway container
# * writes RR_TEST_PG_TLS_PORT and RR_TEST_PG_TLS_CA to $GITHUB_ENV when set,
#   and always prints them
#
# The image is the one the pgvector tests already use. Nothing is written
# outside the output directory; no key is committed.
set -euo pipefail

NAME=${1:-rr-pgtls}
PORT=${2:-55434}
OUT=${3:-$(mktemp -d)}
IMAGE=${RR_TEST_PG_TLS_IMAGE:-pgvector/pgvector:0.8.0-pg16}

mkdir -p "$OUT"
cd "$OUT"
mkca() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$1.key" -out "$1.pem" \
    -days 2 -subj "/CN=rr throwaway $1" -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}
mkca ca
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
printf "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 2 -extfile server.ext 2>/dev/null
chmod 600 ./*.key

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker create --name "$NAME" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_USER=rruser -e POSTGRES_PASSWORD=rrpass -e POSTGRES_DB=rrtenant \
  --entrypoint bash "$IMAGE" -c '
set -e
install -d /certs
install -o postgres -g postgres -m 600 /certsrc/server.key /certs/server.key
install -o postgres -g postgres -m 644 /certsrc/server.pem /certs/server.pem
cat > /docker-entrypoint-initdb.d/00-tenants.sh <<"EOS"
#!/bin/bash
set -e
sed -i "1i hostnossl all all all reject" "$PGDATA/pg_hba.conf"
for t in orga orgb; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "CREATE ROLE r_$t LOGIN PASSWORD '"'"'pw_$t'"'"'" -c "CREATE DATABASE t_$t OWNER r_$t"
done
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS vector"
EOS
chmod +x /docker-entrypoint-initdb.d/00-tenants.sh
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.pem -c ssl_key_file=/certs/server.key \
  -c log_connections=on
' >/dev/null
docker cp "$OUT" "$NAME:/certsrc"
docker start "$NAME" >/dev/null

# Ready only when the post-initdb server answers on TCP with TLS (the init-time server is socket-only).
ready=
for _ in $(seq 1 60); do
  if docker exec -e PGPASSWORD=rrpass "$NAME" psql "host=localhost user=rruser dbname=t_orgb sslmode=require" \
      -tAc "select 1" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || { echo "$NAME did not become ready" >&2; docker logs --tail 40 "$NAME" >&2; exit 1; }

lines="RR_TEST_PG_TLS_PORT=${PORT}
RR_TEST_PG_TLS_CA=${OUT}/ca.pem"
echo "$lines"
if [ -n "${GITHUB_ENV:-}" ]; then echo "$lines" >> "$GITHUB_ENV"; fi
