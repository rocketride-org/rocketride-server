# Failure Scenarios (what NOT to do)

Negative examples. Weak models improve markedly with explicit "this is wrong, here's why."
Each shows a tempting mistake, what happens, and the correct move.

## ❌ Fabricating a node that isn't in the index
> User: "add a `transform` node to clean the data."
A `transform` node does **not** exist in the catalog (it appears in an old doc as a placeholder).
**Wrong:** wire in `transform` anyway → `The service transform was not found` at run time.
**Right:** check the index. There's no `transform`. STOP and offer real options: a `preprocessor_*`
node, `anonymize_text`, `extract_data` (needs an LLM), or ask what cleanup is needed. Never invent
a node — if it's not in the index, it doesn't exist.

## ❌ Wiring a lane that doesn't match
> Plan: `chat → qdrant` directly (skip embedding).
qdrant's input on the `questions` lane needs **vectorized** questions; chat emits raw `questions`.
**Wrong:** `chat_1 → qdrant_1` → store returns nothing / errors; the query was never embedded.
**Right:** `chat → embedding_transformer → qdrant`. Embedding is mandatory before any store, and
the query embedding must match the ingest embedding.

## ❌ Guessing a config field
> Setting `"max_tokens": 4096` on `llm_openai`.
The real field is `modelTotalTokens`, and the key nests under the profile.
**Wrong:** `validate()` rejects unknown field / the limit is ignored.
**Right:** fetch the schema (`describe_component llm_openai` / the shim), read `Pipe.schema` +
`dependencies.profile.oneOf`, set
`{"profile":"openai-4o","openai-4o":{"apikey":"${ROCKETRIDE_OPENAI_KEY}"}}`.

## ❌ Putting the control array on the agent
> `agent_rocketride` config lists its `llm` and `tools`.
**Wrong:** the agent has no `control` array; nothing is invoked → agent does nothing.
**Right:** the **llm**/**tool**/**memory** nodes each carry `control: [{classType, from: <agent>}]`
pointing back at the agent.

## ❌ Claiming success without checking
> "I submitted the run, so it worked. Here's your answer: …"
**Wrong:** `use()` only started it; the "answer" is invented.
**Right:** poll `get_task_status` to a terminal state, read the real result/`result_types`, and
quote it. Submitted ≠ succeeded.

## ❌ Self-approving a dismissed gate
> Gate C.5 (cost) dialog dismissed; agent thinks "they probably meant yes" and runs.
**Wrong:** burns the user's money on an unapproved run.
**Right:** dismissed = unanswered = STOP. Re-present the cost gate and wait.

## ❌ Hardcoding a secret
> `"apikey": "sk-..."`
**Wrong:** leaks the key; breaks env substitution.
**Right:** `"apikey": "${ROCKETRIDE_OPENAI_KEY}"` and set the env var.

## ❌ Blocking the event loop when running
> Using `input("Question: ")` or `time.sleep` inside the async run.
**Wrong:** freezes the websocket keepalive → `Connection closed` after ~60s.
**Right:** use async I/O; never block the async loop.
