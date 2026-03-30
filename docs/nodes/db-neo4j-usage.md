# db_neo4j Node — Usage Guide

The `db_neo4j` node executes Cypher queries against a Neo4j database.

## Configuration

```json
{
  "id": "query_node",
  "type": "db_neo4j",
  "label": "Query Neo4j",
  "config": {
    "uri_env": "NEO4J_URI",
    "user_env": "NEO4J_USER",
    "password_env": "NEO4J_PASSWORD",
    "query": "MATCH (c:Company {name: $name}) RETURN c.industry, c.overall_severity"
  }
}
```

Environment variables:

```
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USER=your_username
NEO4J_PASSWORD=your_password
```

## Patterns

### Read: fetch related nodes

```cypher
MATCH (c:Company)-[:FOUNDED_BY]->(f:Founder)
RETURN f.name, f.email, c.name AS company
ORDER BY c.overall_severity ASC
```

### Write: update after analysis

```cypher
MERGE (c:Company {name: $company_name})
ON CREATE SET c.industry = $industry, c.created_at = datetime()
SET c.overall_severity = $severity, c.analyzed_at = datetime()
RETURN c.name
```

### Graph algorithm (Cypher-based Louvain fallback)

```cypher
MATCH (c:Company)-[r:PATTERN_MATCH]->(other:Company)
WITH c, r.shared_signal AS signal, count(r) AS cnt
ORDER BY cnt DESC
WITH c, collect(signal)[0] AS dominant
SET c.communityId = CASE dominant
  WHEN 'MARGIN_COMPRESSION' THEN 0
  WHEN 'CONCENTRATION_RISK' THEN 1
  ELSE 99
END
RETURN count(c) AS updated
```

## Two db_neo4j Nodes in One Pipeline

Neo4j appears twice in the Portfolio Brain cascade pipeline — once to read patterns,
once to write results. This is a common pattern:

```
[Input] → [db_neo4j: Read] → [llm_openai: Analyze] → [db_neo4j: Write] → [Output]
```

The write node receives the LLM output and persists results back to the graph.

## Neo4j Aura

For cloud Neo4j (Aura), use the `neo4j+s://` URI scheme:

```
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
```

Note: GDS algorithms require AuraDS or self-managed Neo4j with the GDS plugin.
The free Aura tier supports standard Cypher but not `gds.*` procedure calls.
