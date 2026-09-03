# Example Pipeline Templates

Ready-to-use `.pipe` templates for common AI workflows. Open any template in the RocketRide VS Code extension to view it in the visual canvas builder, or run it programmatically with the Python or TypeScript SDK.

## Templates

### rag-pipeline.pipe

**Full RAG (Retrieval-Augmented Generation) system** with separate ingestion and query flows.

```
Ingestion:  webhook -> parse -> preprocessor -> embedding -> Qdrant
Query:      chat -> embedding -> Qdrant -> prompt -> LLM -> response
```

- Ingests documents via webhook, chunks text, embeds with miniLM, and stores in Qdrant
- Answers questions by embedding the query, retrieving relevant documents, and generating an answer with GPT-4o
- Uses the prompt node to merge retrieved context with the user's question

**Required env vars:** `ROCKETRIDE_OPENAI_KEY`, `ROCKETRIDE_QDRANT_HOST`, `ROCKETRIDE_COLLECTION_NAME`

---

### llm-benchmark.pipe

**Compare three LLM providers side-by-side** using parallel agent fan-out.

```
chat -> agent (OpenAI)    ->
chat -> agent (Anthropic)  -> response (all answers)
chat -> agent (Gemini)     ->
```

- Sends the same question to three agents, each backed by a different LLM provider
- All answers are collected into a single response for comparison
- Uses RocketRide, CrewAI, and LangChain agent frameworks

**Required env vars:** `ROCKETRIDE_OPENAI_KEY`, `ROCKETRIDE_ANTHROPIC_KEY`, `ROCKETRIDE_GEMINI_KEY`

---

### document-processor.pipe

**Document processing pipeline** with OCR, named entity recognition, and PII anonymization.

```
webhook -> parse -> OCR (images) -> NER -> anonymize -> response
```

- Accepts documents via webhook and parses all content types
- Runs OCR on extracted images to recover text
- Identifies named entities with NER
- Anonymizes PII (names, addresses, etc.) before returning the cleaned text

**Required env vars:** None (uses local models)

---

### agent-workflow.pipe

**Multi-agent pipeline** with hierarchical tool use and a research sub-agent.

```
chat -> orchestrator agent -> response
           |
    +------+------+------+
    |      |      |      |
   LLM  Memory  HTTP  Python
                  |
            research agent (sub-agent as tool)
                  |
           +------+------+
           |      |      |
          LLM  Memory  HTTP
```

- An orchestrator agent coordinates tools and delegates to a research sub-agent
- The research sub-agent uses HTTP requests to gather web information
- Each agent has its own LLM and memory for independent reasoning
- The orchestrator uses GPT-4o; the research agent uses Claude

**Required env vars:** `ROCKETRIDE_OPENAI_KEY`, `ROCKETRIDE_ANTHROPIC_KEY`

### n8n-roundtrip.pipe

**Call an n8n workflow from a RocketRide pipeline** (pairs with `n8n-call-rocketride.workflow.json`).

```text
webhook -> tool_n8n (triggers n8n workflow "rocketride-demo") -> response
```

- Lane input is POSTed to the n8n workflow's webhook; the workflow's response flows downstream
- Import the companion `n8n-call-rocketride.workflow.json` into n8n for the other half of an RR→n8n→RR round-trip
- See the [n8n integration guide](../docs/README-n8n.md) for setup, activation, and Docker-reachability notes

**Required env vars:** `ROCKETRIDE_N8N_URL` (e.g. `http://localhost:5678`), `ROCKETRIDE_N8N_KEY` (only for async mode / listing)

The [`n8n/`](n8n/) subfolder has runnable test pipes covering every mode — `n8n-fanout.pipe` (sync + async + sequential), `n8n-agent.pipe` (agent calls n8n as a tool), and `n8n-roundtrip.pipe` + `n8n-roundtrip-target.pipe` (the full RR→n8n→RR loop).

---

### agent-llamaindex.pipe

**Single-agent pipeline** using the LlamaIndex agent framework, backed by Claude.

```text
chat -> LlamaIndex agent -> response
              |
        +-----+-----+
        |           |
       LLM        HTTP
     (Claude)    (tool)
```

- A LlamaIndex ReAct agent answers questions, calling the HTTP request tool when it helps
- Backed by Anthropic's Claude (Sonnet 4.6) via the `llm` control channel

**Required env vars:** `ROCKETRIDE_ANTHROPIC_KEY`

---

### slack-agent.pipe

**Slack-connected agent** that can post messages, list channels, and read channel history.

```text
chat -> agent (RocketRide Wave) -> response
                 |
          +------+------+
          |      |      |
         LLM  Memory  Slack (tool)
```

- The agent acts on your Slack workspace via the `slack.*` tools: `message_post` (channel or thread), `channels_list`, `channel_history`, and `check_connection`
- Ask it to announce a result in a channel, or to summarize recent discussion before answering
- The bot must be invited to any channel it should post to or read (`/invite @your-bot`); see the [tool_slack README](../nodes/src/nodes/tool_slack/README.md) for the app setup and required scopes
- For zero-scope, post-only setups, set the node's `webhookUrl` (Slack incoming webhook) instead of `token`

**Required env vars:** `ROCKETRIDE_ANTHROPIC_KEY`, `ROCKETRIDE_SLACK_TOKEN` (a bot token with `chat:write`, `channels:read`, `channels:history`)

### guild-agent.pipe

**Run a governed [Guild.ai](https://www.guild.ai/) agent as a pipeline step.**

```text
chat -> Guild.ai -> response
```

- Sends the chat input to the agent configured on the node, waits for the Guild session to finish, and emits its answer
- Deterministic: the step runs the agent exactly once, no prompt tuning
- Each run starts a billed Guild session. On timeout the step raises but does **not** cancel the session on Guild's side (it keeps running and billing), so re-running the pipeline starts a new one — raise the node's session timeout rather than re-running a slow session
- See the [tool_guild README](../nodes/src/nodes/tool_guild/README.md) for creating a Guild trigger API key

**Required env vars:** `ROCKETRIDE_GUILD_KEY_ID`, `ROCKETRIDE_GUILD_KEY_SECRET`, `ROCKETRIDE_GUILD_OWNER`, `ROCKETRIDE_GUILD_WORKSPACE`, `ROCKETRIDE_GUILD_AGENT`

### guild-delegate-agent.pipe

**A RocketRide agent that delegates actions to a governed Guild.ai agent.**

```text
chat -> agent (RocketRide Wave) -> response
                 |
          +------+------+
          |      |      |
         LLM  Memory  Guild.ai (tool)
```

- The agent answers directly, but delegates actions on governed systems to Guild by calling `tool_guild_1.run_agent`
- Guild's runtime injects credentials, so the delegated agent acts without the pipeline ever holding the raw keys
- Each `run_agent` call starts a billed, non-idempotent Guild session; the instructions tell the agent to call it once and not retry blindly

**Required env vars:** `ROCKETRIDE_ANTHROPIC_KEY`, `ROCKETRIDE_GUILD_KEY_ID`, `ROCKETRIDE_GUILD_KEY_SECRET`, `ROCKETRIDE_GUILD_OWNER`, `ROCKETRIDE_GUILD_WORKSPACE`, `ROCKETRIDE_GUILD_AGENT`

### hydra/

**Two thousand agents, two thousand databases, nobody wrote the queries.** A runnable demo
app: three pipelines plus a swarm driver.

```text
Hunt:       driver -> N pipeline runs -> N agents, each on its own beat, through its own lens,
                      each in its own private mutable Hotdata database it is free to wreck
Refutation: every claim -> 3 skeptics -> 3 fresh databases holding rows the discoverer never saw
Leaderboard: chat -> head of intelligence -> ONE Hotdata database of the survivors
```

- Nobody tells the swarm what to look for. Heads are assigned a corner of the data and one of twenty ways of looking at it
- Claims survive only if they replicate out of sample, on a hash-disjoint slice with provably zero overlap
- Runs against a control arm - one analyst, one database, all the data - and scores both against a planted answer key
- Includes a trap: a real pattern confined to one narrow window, which the refutation round exists to kill

**Required env vars:** `ROCKETRIDE_ANTHROPIC_KEY`, `ROCKETRIDE_DB_HOTDATA_KEY`, `ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID`

See [`hydra/README.md`](hydra/README.md). Try `python hydra.py --dry-run` first: no keys, no network.

---

### blast-radius/

**One ephemeral Hotdata database per tenant, all of them at once.** The calmer sibling of
`hydra/`: forensic rather than exploratory, same architecture with a straight face. Two
pipelines plus a fan-out driver.

```text
Fan-out:  driver -> N pipeline runs -> N agents -> N private Hotdata databases -> N verdicts
Roll-up:  chat -> incident commander agent -> ONE Hotdata database holding all N verdicts
```

- Every tenant is investigated in its own database, so isolation is structural rather than a `WHERE` clause
- Each analyst agent loads the tenant's logs and invoices, builds a BM25 index, queries in SQL, and returns one verdict row
- The roll-up agent answers natural-language questions across the whole population
- The corpus is generated with known ground truth and decoys, so the run scores its own precision and recall

**Required env vars:** `ROCKETRIDE_ANTHROPIC_KEY`, `ROCKETRIDE_DB_HOTDATA_KEY`, `ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID`

See [`blast-radius/README.md`](blast-radius/README.md). Try `python blast_radius.py --dry-run` first: no keys, no network.

---

### symphony-test/

**Twenty agents, twenty-two databases, verified against a live engine.** Not a demo app: the
acceptance harness that proves the multi-agent patterns actually hold, and the place their
failure modes are recorded.

```text
Rooms:      20 independent runs -> 20 private databases (created and destroyed per run)
Evidence:   all 20 attach to ONE shared database; verdicts published by the answers lane
Telemetry:  a 22nd database whose id persists to disk, so runs accumulate across sessions
Composer:   one run over shared evidence, after every room is gone
```

- Dependency-ordered waves: later rooms hold only a decoy and cannot answer without reading
  what an earlier wave published
- Publishing is wiring, not an instruction — agents told to write to a shared database do it
  roughly one time in four
- Telemetry is queried live at the end: cross-session, cross-agent, concurrency and failure patterns

**Required env vars:** `ROCKETRIDE_OPENAI_KEY`, `ROCKETRIDE_DB_HOTDATA_KEY`, `ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID`

See [`symphony-test/RESULTS.md`](symphony-test/RESULTS.md). Try
`python test_symphony_waves.py --wiring-only` first: no keys, no network.

---

## Getting Started

1. Copy a template to your project directory
2. Set the required environment variables in your `.env` file
3. Open the `.pipe` file in VS Code with the RocketRide extension, or run it with the SDK:

**Python:**

```python
from rocketride import RocketRideClient

client = RocketRideClient()
await client.connect()
result = await client.use(filepath='rag-pipeline.pipe')
```

**TypeScript:**

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient();
await client.connect();
const result = await client.use({ filepath: 'rag-pipeline.pipe' });
```

See the [Pipeline Rules](../docs/agents/ROCKETRIDE_PIPELINE_RULES.md) and [Component Reference](../docs/agents/ROCKETRIDE_COMPONENT_REFERENCE.md) for detailed documentation.
