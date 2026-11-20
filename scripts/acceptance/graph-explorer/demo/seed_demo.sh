#!/usr/bin/env bash
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
# Seed a small fictional demo dataset into the local disposable test containers,
# for product screenshots only. Graph: DEMO_GRAPH (default gx_demo) on FalkorDB
# and AGE, which this script DROPS and recreates; Neo4j nodes carry demo:true, and
# the script deletes EVERY Neo4j node with demo:true first, whoever created it.
# SQL: ${DEMO_SQL_PREFIX}customers / products / orders
# (default prefix demo_), which this script DROPS and recreates.
# Point it only at disposable containers. The credentials below are throwaway
# LOCAL-ONLY test values for those containers, not secrets.
set -euo pipefail

AGE_CONTAINER=${AGE_CONTAINER:-gx-age}
SQL_CONTAINER=${SQL_CONTAINER:-gx-pgvector}
NEO4J_CONTAINER=${NEO4J_CONTAINER:-gx-neo4j}
FALKORDB_CONTAINER=${FALKORDB_CONTAINER:-gx-falkordb}
PG_USER=${PG_USER:-rruser}
PG_DATABASE=${PG_DATABASE:-rrtenant}
NEO4J_USER=${NEO4J_USER:-neo4j}
NEO4J_PASSWORD=${NEO4J_PASSWORD:-gxlocal-test-pass}
DEMO_GRAPH=${DEMO_GRAPH:-gx_demo}
P=${DEMO_SQL_PREFIX:-demo_}
case "$DEMO_GRAPH$P" in *[!A-Za-z0-9_]*) echo "DEMO_GRAPH and DEMO_SQL_PREFIX must be [A-Za-z0-9_]" >&2; exit 2;; esac

CYPHER="CREATE
 (maya:Person {name: 'Maya Chen', role: 'Data engineer', since: 2019}),
 (omar:Person {name: 'Omar Haddad', role: 'ML engineer', since: 2021}),
 (lena:Person {name: 'Lena Fischer', role: 'Product lead', since: 2017}),
 (ravi:Person {name: 'Ravi Kumar', role: 'Backend engineer', since: 2020}),
 (sofia:Person {name: 'Sofia Rossi', role: 'Designer', since: 2022}),
 (tom:Person {name: 'Tom Okafor', role: 'Analyst', since: 2018}),
 (northwind:Company {name: 'Northwind Labs', founded: 2012, employees: 240}),
 (bluefin:Company {name: 'Bluefin Analytics', founded: 2016, employees: 85}),
 (orbital:Company {name: 'Orbital Data', founded: 2020, employees: 32}),
 (atlas:Project {name: 'Graph Atlas', language: 'TypeScript', stars: 1840}),
 (lake:Project {name: 'Signal Lake', language: 'Python', stars: 920}),
 (forge:Project {name: 'Query Forge', language: 'Rust', stars: 2310}),
 (relay:Project {name: 'Event Relay', language: 'Go', stars: 455}),
 (lisbon:City {name: 'Lisbon', country: 'Portugal'}),
 (toronto:City {name: 'Toronto', country: 'Canada'}),
 (pune:City {name: 'Pune', country: 'India'}),
 (maya)-[:WORKS_AT {since: 2019}]->(northwind),
 (omar)-[:WORKS_AT {since: 2021}]->(northwind),
 (lena)-[:WORKS_AT {since: 2017}]->(bluefin),
 (ravi)-[:WORKS_AT {since: 2020}]->(orbital),
 (sofia)-[:WORKS_AT {since: 2022}]->(bluefin),
 (tom)-[:WORKS_AT {since: 2018}]->(orbital),
 (maya)-[:KNOWS]->(omar), (omar)-[:KNOWS]->(maya),
 (maya)-[:KNOWS]->(lena), (lena)-[:KNOWS]->(sofia),
 (ravi)-[:KNOWS]->(tom), (tom)-[:KNOWS]->(maya), (sofia)-[:KNOWS]->(ravi),
 (maya)-[:CONTRIBUTES_TO {commits: 412}]->(atlas),
 (omar)-[:CONTRIBUTES_TO {commits: 188}]->(lake),
 (ravi)-[:CONTRIBUTES_TO {commits: 640}]->(forge),
 (ravi)-[:CONTRIBUTES_TO {commits: 73}]->(relay),
 (lena)-[:CONTRIBUTES_TO {commits: 21}]->(atlas),
 (tom)-[:CONTRIBUTES_TO {commits: 95}]->(lake),
 (sofia)-[:CONTRIBUTES_TO {commits: 54}]->(atlas),
 (northwind)-[:BUILDS]->(atlas), (northwind)-[:BUILDS]->(lake),
 (orbital)-[:BUILDS]->(forge), (bluefin)-[:BUILDS]->(relay),
 (forge)-[:DEPENDS_ON]->(relay), (atlas)-[:DEPENDS_ON]->(forge),
 (northwind)-[:LOCATED_IN]->(lisbon), (bluefin)-[:LOCATED_IN]->(toronto), (orbital)-[:LOCATED_IN]->(pune),
 (maya)-[:LIVES_IN]->(lisbon), (omar)-[:LIVES_IN]->(lisbon), (lena)-[:LIVES_IN]->(toronto),
 (sofia)-[:LIVES_IN]->(toronto), (ravi)-[:LIVES_IN]->(pune), (tom)-[:LIVES_IN]->(pune)"

echo "== FalkorDB $DEMO_GRAPH"
docker exec "$FALKORDB_CONTAINER" redis-cli GRAPH.DELETE "$DEMO_GRAPH" >/dev/null 2>&1 || true
docker exec "$FALKORDB_CONTAINER" redis-cli GRAPH.QUERY "$DEMO_GRAPH" "$CYPHER" | grep -E "created|set" | tr '\n' ' '; echo

echo "== AGE $DEMO_GRAPH ($PG_DATABASE)"
docker exec -i "$AGE_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DATABASE" -q <<SQL
LOAD 'age';
SET search_path = ag_catalog, "\$user", public;
SELECT CASE WHEN EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = '${DEMO_GRAPH}') THEN drop_graph('${DEMO_GRAPH}', true) END;
SELECT create_graph('${DEMO_GRAPH}');
SELECT * FROM cypher('${DEMO_GRAPH}', \$cy\$ ${CYPHER} \$cy\$) AS (a agtype);
SELECT count(*) AS age_nodes FROM cypher('${DEMO_GRAPH}', \$cy\$ MATCH (n) RETURN n \$cy\$) AS (n agtype);
SQL

echo "== Neo4j (demo:true)"
NEO_CYPHER=$(echo "$CYPHER" | sed -E "s/\{name: /{demo: true, name: /g")
docker exec "$NEO4J_CONTAINER" cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" "MATCH (n {demo: true}) DETACH DELETE n" >/dev/null
docker exec "$NEO4J_CONTAINER" cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" "$NEO_CYPHER" >/dev/null
docker exec "$NEO4J_CONTAINER" cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" "MATCH (n {demo: true}) RETURN count(n) AS neo4j_demo_nodes"

echo "== Postgres demo tables ${P}customers, ${P}products, ${P}orders ($PG_DATABASE)"
docker exec -i "$SQL_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DATABASE" -q <<SQL
DROP TABLE IF EXISTS ${P}orders, ${P}products, ${P}customers;
CREATE TABLE ${P}customers (id serial PRIMARY KEY, name text NOT NULL, city text, country text, signed_up date);
CREATE TABLE ${P}products (id serial PRIMARY KEY, sku text UNIQUE, name text NOT NULL, category text, price numeric(10,2));
CREATE TABLE ${P}orders (id serial PRIMARY KEY, customer_id int REFERENCES ${P}customers(id), product_id int REFERENCES ${P}products(id), quantity int, ordered_at timestamptz);
INSERT INTO ${P}customers (name, city, country, signed_up) VALUES
 ('Northwind Labs','Lisbon','Portugal','2023-02-14'), ('Bluefin Analytics','Toronto','Canada','2023-06-01'),
 ('Orbital Data','Pune','India','2024-01-09'), ('Harbor Freight Co','Rotterdam','Netherlands','2022-11-21'),
 ('Copperline','Austin','USA','2024-03-30'), ('Kestrel Health','Dublin','Ireland','2023-09-12');
INSERT INTO ${P}products (sku, name, category, price) VALUES
 ('RR-PIPE-01','Pipeline seats (10)','Licence',1200.00), ('RR-GPU-08','GPU hours (100)','Compute',890.00),
 ('RR-STOR-1T','Vector storage 1 TB','Storage',340.00), ('RR-SUP-PRO','Pro support','Support',2500.00),
 ('RR-CONN-DB','Database connector pack','Add-on',150.00);
INSERT INTO ${P}orders (customer_id, product_id, quantity, ordered_at)
SELECT 1 + (g % 6), 1 + ((g * 7) % 5), 1 + (g % 4), timestamptz '2026-07-01' + (g || ' days')::interval
FROM generate_series(1, 40) g;
SQL
docker exec "$SQL_CONTAINER" psql -U "$PG_USER" -d "$PG_DATABASE" -Atc "select '${P}customers', count(*) from ${P}customers union all select '${P}products', count(*) from ${P}products union all select '${P}orders', count(*) from ${P}orders"
