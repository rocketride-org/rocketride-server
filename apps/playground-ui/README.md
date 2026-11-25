# Playground

One front end for every agent. Open an agent, then talk to it: ask it questions, drop files on it, and see what comes back, drawn by what each answer is. Every agent you open is a **connection**, and each connection keeps its **conversations**.

One package, two ways in:

- **In the browser**: a signed-in deep link, `?appid=rocketride.playground&pipe=<address>`, or an agent tile on the desktop or in the Catalog, opens the agent. With no `pipe=`, the app shows the agent picker.
- **As a dev tool** in Rocket Builder and VS Code: the connections tree sits in the tool sidebar, and each agent opens as its own tab.

---

## What it does

- **Connections and conversations.** The sidebar is a tree: each agent you have opened, and under it its conversations, newest first. They are kept in your own file store through the shared agent session store (`.agents/rocketride.playground/`), so they are the same in the browser, Rocket Builder and VS Code.
- **The bottom bar follows the agent.** An agent that reads questions gets the chat input; one that reads files gets a drop bar; one that reads both gets the chat input with an attach button.
- **Answers in the conversation.** Your files upload with their progress in your bubble; the agent's bubble shows what it is doing while it works, then the results: a field table, text, documents, a gallery, or a table, with tabs when an answer carries several kinds.
- **Agents that work on their own.** An agent whose source listens or scans takes nothing here; the Playground says so and offers what you can do instead. Nothing is ever sent to it.
- **Simple and Advanced.** Simple shows plain answers with friendly field names; Advanced shows keys as returned, Raw, and where the call answered.

## Addresses

`developerId.pipelineId` is the agent; `developerId.pipelineId.source` names one of its sources.

## Development

```bash
./builder playground-ui:build   # bundle + register in apps.json + copy to dist
./builder playground-ui:dev     # rsbuild dev server
./builder playground-ui:test    # node:test over tests/
```

Platform guide for apps: `.rocketride/docs/ROCKETRIDE_APPS.md`.
