# Open Questions — filesys-refactor

_All resolved from the codebase, 2026-07-29. No open questions remain._

1. **Source byte-delivery mechanics — RESOLVED.** Copy the telegram push pattern
   (`nodes/src/nodes/telegram/IEndpoint.py:443-511`), the only proven raw-bytes
   delivery in the repo: per file, `target.getPipe()` → `pipe.open(entry)` →
   `writeTagBeginObject`/`writeTagBeginStream` → `writeTagData(bytes)` →
   `writeTagEndStream`/`writeTagEndObject` → `pipe.close()` → `putPipe()`, with
   the entry built via `getObject(obj={url, name, size, mimeType})`
   (`rocketlib/types.py:528`). `self.endpoint.target` is populated before
   `scanObjects` is called (`webhook/IEndpoint.py:50`). A finite source simply
   returns from `scanObjects` when done — no blocking server, and the engine's
   scan callback goes unused (it delivers metadata only; the alternative
   engine-driven `renderObject` pull path has no Python raw-bytes precedent).
   Raw bytes ride the `tags` lane (`"lanes": {"_source": ["tags"]}`, dropper
   precedent) to a downstream Parser.

2. **Variant gating in shared driver — RESOLVED: none needed.** Gating is fully
   declarative. Undeclared input lanes are rejected at pipeline build
   (`packages/server/engine-lib/engLib/store/pipeline/pipeline_config.cpp:298`),
   so a `"lanes": {}` variant never receives lane traffic. Tool discovery rides
   the `"tool"` control channel keyed off classType-driven graph edges
   (`packages/ai/src/ai/common/agent/_internal/host.py:69`,
   `engLib/store/stack.cpp:193`), so a non-`"tool"` variant is never exposed as
   an agent tool. Runtime branching (`self.IGlobal.glb.logicalType` /
   `self.endpoint.logicalType`, webhook pattern) exists if ever needed — it is
   not needed here.

3. **`classType: ["store"]` side effects — RESOLVED: inert and safe.** Nothing
   in the codebase invokes or controls a `"store"` channel; the value is a
   config/UI-time super-type only (provider dropdowns,
   `engLib/store/services/services.cpp:965`). Precedent: `rocketride_vector`
   ships store-only with no handlers.

**One design deviation recorded:** the design said a nonexistent source path
fails in `validateConfig`. Path *existence* requires store access and a
`ROCKETRIDE_CLIENT_ID`, which config-time validation doesn't have, so
`validateConfig` enforces only that `path` is non-empty; a nonexistent path
raises at `scanObjects` time and fails the task with a clear error.
