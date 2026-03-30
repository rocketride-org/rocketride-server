# Example: Portfolio Brain — Financial Intelligence Network

Built at HackwithBay 2.0 using Neo4j (sponsor) + GMI Cloud + RocketRide.

## What It Does

Analyzes startup financials and detects risk patterns using graph intelligence.
When a new company is analyzed, the `portfolio_cascade.pipe` pipeline:

1. **Parallel GDS fan-out** — Runs community detection, node similarity, and PageRank simultaneously
2. **Founder recommendations** — Updates peer connections based on new similarity scores
3. **Emergence detection** — Checks if new company tips any cross-portfolio signal thresholds
4. **Notification** — Flags relevant founders about new peer connections

## Why RocketRide

Steps 1-3 are independent — they all just need the updated Neo4j graph. Sequential execution
wastes 3× the time. RocketRide's parallel DAG makes this a non-issue.

## Pipeline

See `portfolio_cascade.pipe` for the visual pipeline definition.

Open in VS Code with the RocketRide extension to see the DAG diagram.

## Stack

- Neo4j Aura (graph database + GDS algorithms)
- GMI Cloud (DeepSeek V3.2, Qwen3, MiniMax for LLM nodes)
- FastAPI (API server)
- React (frontend with force-directed graph)

**Repo:** https://github.com/josephmccann/portfolio-brain
