# PROVISIONAL CONTRACT v1 wire fixtures (hand-modelled)

Hand-modelled from CONTRACT v1, NOT produced by driver objects or the node tools, and
never regenerated or compared with generator output (graph-ui's tests in CI do read
them, as below). The generated sets are in `../v1/` (driver goldens)
and `../v1/live/` (captures of the real tool path), both from
`nodes/test/graph_wire_fixtures.py`. graph-ui's fixture tests (`graph.fixtures.test.ts`)
run the per-engine `read_query_*` files here alongside the generated v1 set, through the
same invariants. graph-ui's other tests read the remaining files on their own: they are
the default inputs of the test helpers (`tests/support/builders.ts`), and they cover the
cases the generated sets do not: truncation by elements, an exact-limit result, scalars,
pre-upgrade nodes, and schema states such as a refresh that never succeeded.

Ids are sentinels: Neo4j elementId strings, FalkorDB small decimal strings, AGE
17-digit graphids incl. 11821949021847553 (> 2^53). Same logical graph on all three:
Alice(Person[,Employee]) -KNOWS-> Bob twice (parallel), Bob -KNOWS-> Alice (reverse),
Alice -LIKES-> Alice (self), Alice -WORKS_AT-> Acme; path p traverses Bob<-Alice->Acme
(traversal order in nodes, STORED direction in start/end). User map `meta` shows @-key
escaping ('@@kind' on the wire == '@kind' in the user's data; strip exactly one '@').
AGE fixture has a duplicate column 'name'. errors.json headline/detail split on the
first newline. dialect_old_node.json / schema_old_node.json = pre-upgrade nodes.
