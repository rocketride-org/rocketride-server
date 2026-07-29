# Open Questions — filesys-refactor

_As of 2026-07-29._

1. **Source byte-delivery mechanics.** How does a Python `register: "endpoint"`
   source deliver object bytes after `scanObjects()` enumerates entries — does the
   engine drive reads back through the instance, or does the endpoint push via
   `sendOpen`/`sendTagBeginStream`/`sendTagData`/`sendClose`? Webhook pushes via its
   web server data channel; telegram stubs `scanObjects`. Must be pinned from the
   engine-side contract during implementation planning, before the source variant is
   coded.

2. **Variant gating in shared driver.** Expectation is that services.json
   declarations alone gate behavior (no lanes → no lane traffic; no `tool` classType
   → no tool discovery). If the engine still routes tool discovery or lane writes to
   the store/tool variants unexpectedly, add explicit gating keyed on
   `logicalType`/protocol.

3. **`classType: ["store"]` side effects.** Per the invoke-channel finding
   (classType keys the C++ controller map), confirm nothing invokes the `store`
   channel on File Store instances in a way that requires handler methods the driver
   doesn't have.
