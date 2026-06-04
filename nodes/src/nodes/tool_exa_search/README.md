# tool_exa_search

Exposes [Exa](https://exa.ai) semantic web search as an agent tool node.

> Experimental — this node is marked `experimental` and may change.

## What it does

Agents invoke this node via the tool invoke channel. The node performs a real-time web search using the Exa API and returns structured results containing titles, URLs, text content, relevance scores, and dates.

Because `lanes` is empty (`{}`), this node has no pipeline input/output lanes — it is consumed exclusively by agent runtimes through the `invoke` capability.

## Setup

Set your Exa API key via the node config field **API Key** (from https://exa.ai). The field is encrypted at rest and masked in the UI.

## Config fields

| Field                | Default | Description                                                       |
| -------------------- | ------- | ----------------------------------------------------------------- |
| API Key              | *(empty)* | Exa API key (from https://exa.ai). Encrypted at rest.           |
| Number of Results    | `10`    | Maximum number of search results to return (1–50).                |
| Use Autoprompt       | `Yes`   | Let Exa optimize the query for better results.                    |
| Search Type          | `Auto`  | `Auto`, `Neural`, or `Keyword`.                                   |
| Include Text Content | `Yes`   | Include full text content in each result.                         |
