# Dropper

The drag-and-drop upload front end of a pipeline. One package, two ways in:

- **In the Builder** — run a pipeline with a `dropper` source and press **Open Dropper** on the node. The drop zone opens as a document beside the canvas, bound to that pipeline's address. Each dropper source is its own document.
- **In the browser** — a signed-in deep link, `?appid=rocketride.dropper&pipe=<address>`, binds the app to one pipe. Which publication answers is decided for the signed-in caller: their own `@me` publication, their teams' in team order, else the publisher's `@public` one. Everyone pays as themselves.

No credential ever rides a URL. The old `/dropper?auth=pk_…` pages are gone; the MCP dropper widget uploads through the MCP module with its own session nonce and links here.

---

## What it does

- Sends each dropped file through the pipe's dropper source with the SDK's `sendFiles()`; the address is the token slot, so the server resolves and, when the engine is dormant, starts the publication that serves you.
- Lists every upload with its outcome and the result the pipeline returned for it.
- With no `pipe=` in the URL, shows the pipe picker: the pipelines published to you and your teams (`@me`, then `@team` in your team order), a store search, and an address field; picking a pipe lists its dropper sources, and choosing one writes `pipe=` into the URL.

## Addresses

`developerId.pipelineId` uses the pipe's default source; `developerId.pipelineId.source` names the dropper source explicitly.

## Development

```bash
./builder dropper-ui:build   # bundle + register in apps.json + copy to dist
./builder dropper-ui:dev     # rsbuild dev server
```

Platform guide for apps: `.rocketride/docs/ROCKETRIDE_APPS.md`.
