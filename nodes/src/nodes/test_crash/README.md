# test_crash

A RocketRide test node that ends its own task process on request. It exists
for the tests of how the server reports a task that dies
(`packages/ai/tests/ai/modules/task/test_task_crash.py`) and is never offered
in the pipeline builder.

## What it does

The node accepts the `text` lane. The text names the way the task process
ends:

| Text | What happens |
|---|---|
| `segv` | The process reads address 0: a segmentation fault |
| `abort` | `os.abort()` |
| `failfast` | Windows `RaiseFailFastException`: no handler in the process runs |
| `sigkill` | The process sends itself `SIGKILL` |
| `exit` | `os._exit(-1)`: an exit, not a crash |
| `sigterm` | The process sends itself `SIGTERM`: a stop the server did not ask for |

Any other text does nothing.

On your own server you can put it in a pipeline to see how your setup
reports a dying task: the console lines, the final status, and the crash
dump when the server runs with `--dumps`.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `text` | `text` | End the task process the way the text names; nothing is forwarded. |

## Configuration

None.

## Limitations

- **Not on a hosted server.** The node is refused there (`nosaas`): ending a
  task process would end it for every caller of a shared engine.
- **Not in the catalog.** It is `internal`: the pipeline builder never offers
  it. A pipeline that names it (`"provider": "test_crash"`) still loads it.
- **It does what it says.** A pipeline that sends it one of the texts above
  loses its task process, with everything that process held.
