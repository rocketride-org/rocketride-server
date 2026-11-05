# Call context probe nodes (test only)

Two test-only nodes for the engine's tool call context checks
(`scripts/acceptance/vector-explorer/phase0/test_g0_7_call_context.py` and
`test_g0_8_payload.py`). They are never registered by a normal engine: they
load only when the engine is started with `--node_path` pointing at this
folder, which holds the `local_nodes` package the engine scans.

| Node | Tools |
| --- | --- |
| `vx_probe_receiver` | `whoami` (the call context of this call), `payload` (a JSON body of about `bytes` bytes; external callers only), `dap_only` (external callers only) |
| `vx_probe_caller` | `call_receiver` (calls the receiver's `whoami` as an agent does, with a plain invoke, with a context forged inside the input, or with one sent as an extra field of the invoke param, and returns what the receiver saw) |

The probes never touch a database or the network.
