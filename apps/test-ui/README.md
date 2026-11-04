# Test UI

A stress- and chaos-testing dashboard for the RocketRide backend and the
TypeScript client SDK. It is an internal developer tool: you point it at a
server, pick test phases or a pre-built chaos scenario, and it genuinely tries
to break things — multiple independent WebSocket connections, flood sends,
mid-send kills, malformed payloads — while charting the fallout live.

---

## What it does

The sidebar holds saved server connections; opening one creates an independent
test session tab (sessions, configs, and selected phases persist in your
workspace). Inside a session you configure a run — pipeline count, sends per
pipeline, ramp-up, kill probability, payload size/type, corruption level —
pick phases, and start it. The dashboard shows live metrics, a swarm view of
pipeline slots, latency percentiles, phase progress, an event stream, and an
API coverage panel.

### Test phases

| Phase | What it does |
|---|---|
| **API Sweep** | Calls every catalogued SDK method with happy-path and negative args |
| **Multi-socket** | N independent WebSocket connections each running pipelines |
| **Backpressure** | Floods sends with zero delay to find server limits |
| **Pipe streaming** | Opens/writes/closes DataPipes with large chunks |
| **Chaos injection** | Server-side `terminate()` mid-send, connection churn, cross-client contention, zombie detection |
| **Concurrent API** | Hammers multiple methods in parallel from all clients |

### Chaos scenarios

One-click presets bundle a config and phase mix: Thundering Herd (64 pipelines
at once), Whack-a-Mole (random kill/restart), Data Flood (1000 concurrent
sends, 1 B–100 MB payloads), Garbage In (malformed JSON, binary noise),
Connection Chaos, File Store Blitz, SEQ Collision, and Full API Sweep.

### API coverage

`src/apiMethods.ts` is the catalog of the client SDK surface the sweep tracks
— each method marked happy-path, negative, or skipped (with a reason:
destructive calls like `disconnect` or `account.deleteTeam` are never
executed). SaaS-only methods (`account.*`, `billing.*`, `deploy.*`) are
flagged and skipped against OSS servers. The coverage panel shows what ran,
passed, and failed per category.

---

## Notes

- This app deliberately stresses whatever server it is pointed at. Do not run
  it against a server other people are using.
- It requires authentication (`authenticated: true`) and connects with real
  credentials saved per connection in the sidebar.
- The SDK method catalog is maintained by hand; when the client SDK surface
  changes, `src/apiMethods.ts` must be updated to match.
