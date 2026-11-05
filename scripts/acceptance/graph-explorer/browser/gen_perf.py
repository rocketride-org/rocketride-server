# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Seeded FalkorDB graph for canvas performance runs (disposable graph PERF_GRAPH, default gx_perf).

N nodes over 6 labels, about 2N relationships: random edges, ~5% parallel
duplicates of an existing edge, ~2% self-loops. Deterministic for a seed.
DELETES and recreates PERF_GRAPH: point it only at a disposable FalkorDB.
Usage: python gen_perf.py <n> [seed]   (needs the falkordb package; the engine has it:
       ./engine <this folder>/gen_perf.py 300)
Env: FALKORDB_HOST (127.0.0.1), FALKORDB_PORT (56379), PERF_GRAPH (gx_perf).
"""

import os
import random
import sys

from falkordb import FalkorDB

N = int(sys.argv[1])
SEED = int(sys.argv[2]) if len(sys.argv) > 2 else 7
rnd = random.Random(SEED)
HOST = os.environ.get('FALKORDB_HOST', '127.0.0.1')
PORT = int(os.environ.get('FALKORDB_PORT', '56379'))
GRAPH = os.environ.get('PERF_GRAPH', 'gx_perf')

g = FalkorDB(host=HOST, port=PORT).select_graph(GRAPH)
try:
    g.delete()
except Exception:  # noqa: BLE001 - first run: no graph yet
    pass
g = FalkorDB(host=HOST, port=PORT).select_graph(GRAPH)

labels = [f'L{i}' for i in range(6)]
nodes = [{'i': i, 'l': labels[i % 6], 'name': f'n{i}'} for i in range(N)]
for lab in labels:
    batch = [n for n in nodes if n['l'] == lab]
    g.query(f'UNWIND $rows AS r CREATE (:P:{lab} {{i: r.i, name: r.name}})', {'rows': batch})
g.query('CREATE INDEX FOR (p:P) ON (p.i)')

edges = []
target = 2 * N
while len(edges) < int(target * 0.93):
    a, b = rnd.randrange(N), rnd.randrange(N)
    if a != b:
        edges.append((a, b))
for _ in range(int(target * 0.05)):
    edges.append(rnd.choice(edges))  # parallel duplicates
for _ in range(int(target * 0.02)):
    x = rnd.randrange(N)
    edges.append((x, x))  # self-loops
rows = [{'a': a, 'b': b} for a, b in edges]
for i in range(0, len(rows), 2000):
    g.query('UNWIND $rows AS r MATCH (a:P {i: r.a}), (b:P {i: r.b}) CREATE (a)-[:R]->(b)', {'rows': rows[i : i + 2000]})
n = g.query('MATCH (n:P) RETURN count(n)').result_set[0][0]
e = g.query('MATCH ()-[r:R]->() RETURN count(r)').result_set[0][0]
print(f'{GRAPH} seeded: nodes={n} rels={e} seed={SEED}')
