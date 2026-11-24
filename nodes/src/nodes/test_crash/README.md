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

## Where it can run

Its capabilities are `internal`, `experimental` and `nosaas`:

- `internal` keeps it out of the catalog. A pipeline that names it
  (`"provider": "test_crash"`) still loads it.
- `nosaas` refuses it on a hosted server. Ending a task process there would
  end it for every caller of a shared engine.

On your own server you can put it in a pipeline to see how your setup
reports a dying task: the console lines, the final status, and the crash
dump when the server runs with `--dumps`.

## Configuration

None.
