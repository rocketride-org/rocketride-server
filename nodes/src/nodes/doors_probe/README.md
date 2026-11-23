# doors_probe

A RocketRide test node that exercises every door a node reads through and
reports what each one answered. It exists for the rung and boundary tests
(`nodes/test/doors_probe`) and is never offered in the pipeline builder.

## What it does

The node accepts the `text` lane and returns a report on the `text` lane.
The text is a JSON script, `{"ops": [{"op": "<name>", ...}, ...]}`; the node
runs the operations in order and forwards
`{"results": [{"op", "ok", "value" | "error"}, ...]}`. A door that refuses an
operation is a result, not a failed call: `error` carries the exception's
type and message, so a test can tell a boundary refusal from a missing
precondition.

The operations cover the whole node contract: the caller, the identity
record and the configuration (`report`); `self.state` (`state.get`,
`state.put`, `state.delete`, `state.incr`, `state.lockedAppend`);
`self.files` (`files.write`, `files.read`, `files.putJson`, `files.getJson`,
`files.stream`, `files.list`, `files.stat`, `files.mkdir`, `files.rename`,
`files.delete`, `files.url`); the binding's logger (`sse`); sub-pipes of the
binding (`subpipe` runs a nested script and returns its report, `recurse`
nests until the engine's depth guard refuses); and the NAMES of the engine
process's environment variables, never their values (`processEnv`). The rest
step outside on purpose: a door kept past its call (`stash`, then `stale.*`),
a door built over a binding of the node's choosing (`forge.*`), another node
id on the node's own binding (`otherNode.*`), a forged caller on a sub-pipe
(`subpipe` with `caller`), and every write into the caller and the read-only
views (`mutate`). The node decides nothing about what should be refused; the
tests own the expectations. This node is experimental and internal.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `text` | `text` | Run the JSON script in the text and return the JSON report. |

## Configuration

The three settings are one of each kind the doors tell apart.

### Label

**Label** is a value of the control. The IGlobal reads it once from
`self.config` in `beginGlobal`, and the report shows it as the control saw it.

### Greeting

**Greeting** is a per-call parameter. `self.settings` serves it with each
call's value; `self.config` refuses it with a `ConfigError` that says to read
it from `self.settings`, and the report shows that refusal from both the
IGlobal and the instance.

### Mode

**Mode** is a selector parameter with two branches, each carrying its own
parameter leaf: **Alpha value** under `alpha` and **Beta value** under
`beta`. A call that switches the mode re-resolves its settings, so it reads
the selected branch's leaf and the other one is not reachable.

## Notes

### The stashed doors

`stash` keeps a call's `self.state` and `self.files` on the control's
IGlobal, which a real node never does: the IGlobal holds caches, never state.
The probe does it so a later call of the same control can show that a door
whose binding has ended reaches nothing.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
