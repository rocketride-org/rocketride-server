# db_neo4j Node — Usage Guide

The `db_neo4j` node accepts natural-language questions, uses a connected LLM to
generate read-only Cypher queries, executes them against a Neo4j database, and
returns results to the pipeline. Write operations (CREATE, MERGE, SET, DELETE,
etc.) are blocked by design.

## Requirements

A connected LLM node is required — the db_neo4j node uses it to translate
questions into Cypher. Connect an LLM via the node's **LLM** invoke port.

## Configuration

```json
{
	"id": "query_node",
	"type": "db_neo4j",
	"label": "Query Neo4j",
	"config": {
		"neo4jdb.uri": "neo4j+s://your-instance.databases.neo4j.io",
		"neo4jdb.auth_method": "userpass",
		"neo4jdb.user": "your_username",
		"neo4jdb.password": "your_password",
		"neo4jdb.database": "neo4j",
		"neo4jdb.db_description": "Portfolio company graph with risk signals and founder relationships"
	}
}
```

### Configuration fields

| Field                    | Default                  | Description                                                                            |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------------------- |
| `neo4jdb.uri`            | `neo4j://localhost:7687` | Bolt URI. Use `neo4j+s://` for TLS (e.g. Aura).                                        |
| `neo4jdb.auth_method`    | `userpass`               | `userpass` or `token` (bearer).                                                        |
| `neo4jdb.user`           | `neo4j`                  | Username (userpass only).                                                              |
| `neo4jdb.password`       | —                        | Password (userpass only).                                                              |
| `neo4jdb.token`          | —                        | Bearer token (token auth only).                                                        |
| `neo4jdb.database`       | `neo4j`                  | Target database name.                                                                  |
| `neo4jdb.db_description` | —                        | Plain-English description of the graph — helps the LLM generate accurate Cypher.       |
| `neo4jdb.max_attempts`   | `5`                      | How many times to retry if the LLM generates invalid Cypher (validated via `EXPLAIN`). |

## How it works

1. Receives a natural-language question on the **questions** lane.
2. Reflects the live graph schema (labels, properties, relationship types).
3. Sends the question + schema to the connected LLM, which returns a Cypher
   `MATCH`/`RETURN` query.
4. Validates the query with `EXPLAIN` and retries up to `max_attempts` times if
   Neo4j rejects it.
5. Executes the query and emits results on the **table**, **text**, and
   **answers** output lanes.

Only read-only Cypher is permitted (`MATCH`, `OPTIONAL MATCH`, `WITH`, `WHERE`,
`RETURN`, `ORDER BY`, `SKIP`, `LIMIT`). Write clauses are rejected before
execution.

## Example queries (natural language → Cypher)

The LLM generates these — you send the natural-language form as input.

### Fetch related nodes

```cypher
MATCH (c:Company)-[:FOUNDED_BY]->(f:Founder)
RETURN f.name, f.email, c.name AS company
ORDER BY c.overall_severity ASC
LIMIT 250
```

### Graph algorithm (Cypher-based Louvain fallback)

```cypher
MATCH (c:Company)-[r:PATTERN_MATCH]->(other:Company)
WITH c, r.shared_signal AS signal, count(r) AS cnt
ORDER BY cnt DESC
WITH c, collect(signal)[0] AS dominant
RETURN c.name, dominant
LIMIT 250
```

## Neo4j Aura

For cloud Neo4j (Aura), use the `neo4j+s://` URI scheme in `neo4jdb.uri`:

```text
neo4j+s://xxxxxxxx.databases.neo4j.io
```

Note: GDS algorithms require AuraDS or self-managed Neo4j with the GDS plugin.
The free Aura tier supports standard Cypher but not `gds.*` procedure calls.
