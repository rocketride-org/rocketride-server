# Chat

The chat front end of a pipeline. One package, two ways in:

- **In the Builder** — run a pipeline with a `chat` source and press **Open Chat** on the node. The conversation opens as a document beside the canvas, bound to that pipeline's address. Each chat source is its own document.
- **In the browser** — a signed-in deep link, `?appid=rocketride.chat&pipe=<address>`, binds the app to one pipe. Which publication answers is decided for the signed-in caller: their own `@me` publication, their teams' in team order, else the publisher's `@public` one. Everyone pays as themselves.

No credential ever rides a URL. The old `/chat?auth=pk_…` pages and the embeddable chat widget are gone.

---

## What it does

- Sends each message through the pipe's chat source with the SDK's `chat()`; the address is the token slot, so the server resolves and, when the engine is dormant, starts the publication that serves you.
- Keeps the transcript, recent history, SSE status lines and answer extraction in the shell's `ChatView` / `useChatMessages`; the app carries no model and no conversation logic.
- With no `pipe=` in the URL, shows how to reach a chat and takes an address by hand. The publication picker (your `@me` and `@team` rows, store search) follows the merged publication table.

## Addresses

`developerId.pipelineId` uses the pipe's default source; `developerId.pipelineId.source` names the chat source explicitly. A pipe with two chat sources is two addresses.

## Development

```bash
./builder chat-ui:build      # bundle + register in apps.json + copy to dist
./builder chat-ui:dev        # rsbuild dev server
```

Platform guide for apps: `.rocketride/docs/ROCKETRIDE_APPS.md`.
