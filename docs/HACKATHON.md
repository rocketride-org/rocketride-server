# RocketRide at HackwithBay 2.0

RocketRide was used (and sponsored) at HackwithBay 2.0. This page documents how
teams integrated it and what patterns emerged.

---

## Portfolio Brain — Financial Intelligence Network

**Team:** josephmccann  
**Track:** Financial AI / Graph Intelligence  
**Sponsors used:** Neo4j + GMI Cloud + RocketRide

### What It Does

Portfolio Brain analyzes startup financials and detects cross-portfolio risk patterns
using a Neo4j graph database. When a new company is analyzed, RocketRide triggers
a cascade pipeline that:

1. Fans out to 3 parallel GDS operations (community detection, node similarity, PageRank)
2. Updates founder recommendation connections
3. Detects cross-portfolio emergence patterns
4. Generates a natural language summary via DeepSeek V3.2

### Why RocketRide

The 3 GDS operations are fully independent — they just need the updated graph state.
Running them sequentially takes 3× longer for no reason.

With RocketRide:
- Define the 3 Neo4j query nodes
- Connect all 3 to a single `preprocessor_code` sync barrier
- The engine parallelizes them automatically

No thread management, no async coordination, no boilerplate.

### Pipeline

See [`examples/portfolio-brain/portfolio_cascade.pipe`](../examples/portfolio-brain/portfolio_cascade.pipe)
for the complete pipeline definition. Open it in VS Code with the RocketRide extension
to see the DAG visualization.

### Integration Pattern

Pipelines triggered from a FastAPI endpoint on every company analysis:

```python
from rocketride import RocketRideClient
import json

def trigger_cascade(company_data: dict):
    client = RocketRideClient(uri=ROCKETRIDE_URI)
    client.connect()
    token = client.use(filepath="./portfolio_cascade.pipe")
    result = client.send(token["token"], json.dumps(company_data),
                         {"name": "company.json"}, "application/json")
    client.terminate(token["token"])
    client.disconnect()
    return result
```

### Stack

- **RocketRide** — parallel DAG execution engine
- **Neo4j Aura** — graph database (GDS for community detection, similarity, PageRank)
- **GMI Cloud** — DeepSeek V3.2, Qwen3 via OpenAI-compatible API
- **FastAPI** — API server triggering pipelines per request
- **React** — force-directed graph visualization

**Repo:** https://github.com/josephmccann/portfolio-brain

---

## Contributing a Hackathon Example

Built something with RocketRide at a hackathon? Open a PR adding your project to
this file and your pipeline to `examples/`. Include:

- Project name and what it does
- Why RocketRide (what problem it solved vs. sequential execution)
- The `.pipe` file in `examples/<your-project>/`
- A brief code snippet showing how you triggered pipelines

We want real-world examples that show RocketRide's value in context.
