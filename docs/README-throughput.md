# Throughput: Replicas, Threads, and Per-Task Concurrency

This guide explains how to get more inference throughput out of the RocketRide
engine, and why the naive answer ("raise `threads`") doesn't do what people
expect.

---

## The model: one task, one model, one inference at a time

Every `use()` call starts exactly one `Task`: one engine subprocess running
one copy of your pipeline's models in memory. Each model instance is guarded
by a single lock, so a task runs **one inference at a time**, no matter how
many requests you send it concurrently. Extra requests queue up behind the
lock inside that task; they do not run in parallel.

This is easy to miss because the engine *is* multithreaded, and the wire
protocol has a `threads` option that sounds like it should fix this. It
doesn't -- see below.

## `threads` is admission width, not inference parallelism

`threads` sizes the engine's component thread pool and the data-admission
semaphore for a task. It controls how many requests can be **in flight**
against a connection at once (in-flight capacity is roughly `connections
x threads`), and how many engine-internal worker threads service
non-inference work (I/O, parsing, chunking, lane routing). It does **not**
parallelize model inference -- the per-model lock still serializes that
regardless of how high `threads` is set.

The server default is `64`. Raising it can help with I/O-bound or
CPU-light pipelines, but it will not increase inference throughput on its
own.

## `replicas` is the throughput lever

`replicas` is a new `use()`/`execute` option that launches **N independent
engine subprocesses** (N full tasks, each with its own model copy) behind a
single token. Inputs sent to that token are round-robined across the
replicas; events from all of them are broadcast back under the same token.
Task begin/end events are emitted once per pipeline (not once per replica);
other events carry a `replica` index so you can tell which replica produced
them.

This is the supported way to run N inferences concurrently on one machine
without opening N connections, minting N tokens, and sharding requests
yourself.

- `replicas` (default `1`, clamped to `1..32`): number of tasks to launch
  for this pipeline.
- Each replica is a **full copy of the model in RAM**. Budget memory
  accordingly -- if a single task's model footprint is `M`, `replicas: 8`
  costs roughly `8 * M`.
- Idle replicas still cost some CPU: in the measurements behind this
  feature, an idle task cost on the order of ~0.6 idle cores just sitting
  there, so don't set `replicas` far above what your traffic can actually
  keep busy.
- A file upload (`send_files`/`sendFiles`) is pinned to a single replica
  for the whole open/write/close session of that upload; round-robin
  distribution happens across separate uploads, not within one.

## `torchThreads` and the BLAS/OMP thread vars

Each replica is its own process, so each one can be given its own
BLAS/OMP thread budget via `torchThreads` (per-replica thread count).
When set (`> 0`), the server injects it into six environment variables in
that replica's subprocess:

- `OMP_NUM_THREADS`
- `MKL_NUM_THREADS`
- `OPENBLAS_NUM_THREADS`
- `VECLIB_MAXIMUM_THREADS`
- `NUMEXPR_NUM_THREADS`
- `TORCH_NUM_THREADS`

If you don't set `torchThreads` and `replicas > 1`, the server picks
`max(1, cpu_count() // replicas)` automatically, so replicas don't
oversubscribe the box by each grabbing every core's worth of BLAS threads.
If you don't set it and `replicas == 1`, nothing is injected -- today's
behavior is preserved exactly.

**The rule of thumb:** keep `replicas * torchThreads` at or below your
core count. Going above it means replicas start fighting each other for
the same cores instead of adding throughput.

## Python and TypeScript examples

**Python:**

```python
client = RocketRideClient()  # config from .env

await client.attach()
await client.login()

result = await client.use(
    filepath='pipeline.pipe',
    replicas=8,
    torch_threads=4,
)
await client.send_files(['./document.pdf'], result['token'])
```

**TypeScript:**

```typescript
const client = new RocketRideClient({ uri: 'https://api.rocketride.ai' });

await client.connect();

const result = await client.use({
	filepath: 'pipeline.pipe',
	replicas: 8,
	torchThreads: 4,
});

const fileObjects = [file1, file2, file3]; // File objects from input
await client.sendFiles(
	fileObjects.map((file) => ({ file })),
	result.token
);
```

Both examples request 8 replicas, each pinned to 4 BLAS/OMP threads -- a
reasonable starting point on a 32-core box.

## Server-wide defaults (env vars)

If you don't want to set `replicas`/`torchThreads` on every `use()` call,
set server-wide defaults via environment variables. These apply whenever a
request omits the corresponding field:

| Env var | Overrides | Default |
| --- | --- | --- |
| `ROCKETRIDE_TASK_REPLICAS` | `replicas` | `1` |
| `ROCKETRIDE_TORCH_THREADS` | `torchThreads` | unset (auto rule above) |

Invalid values fall back to the default and log a warning rather than
failing the server.

**Docker:**

```bash
docker run -e ROCKETRIDE_TASK_REPLICAS=8 -e ROCKETRIDE_TORCH_THREADS=4 \
  ghcr.io/rocketride-org/rocketride-engine:latest
```

**Helm** (`deploy/helm/rocketride/values.yaml`):

```yaml
env:
  ROCKETRIDE_TASK_REPLICAS: '8'
  # ROCKETRIDE_TORCH_THREADS: '4'
```

## `ttl` is an idle timer, not a batch deadline

`ttl` controls how long a task (or, with replicas, the whole group of
replicas behind a token) may sit idle before the server tears it down.
`ttl == 0` means never time out. With replicas, the group is only
considered idle -- and eligible for cleanup -- once **every** replica has
been idle for `ttl` seconds; a busy replica keeps the whole group alive.

Pick a finite `ttl` carefully on long-running batch jobs: it measures idle
time, not job duration, but a task that goes quiet between chunks of a
long batch (e.g. waiting on a slow upstream source) can still be killed
mid-run if the gap exceeds `ttl`. Use `ttl: 0` for long-running or
bursty-input batch pipelines where you control the lifecycle yourself.

## The real fix: `--modelserver`

`replicas` gets you more *processes* running the model. The underlying
reason a single task can't run concurrent inference is that the model
lock exists in the first place -- each task owns a private, exclusive
copy of the model. The engine has a `--modelserver` option that changes
this: the bare flag starts a local model server, or `--modelserver=<PORT|HOST:PORT>`
points at an existing one; either way it turns the per-model lock into a
no-op and routes inference through a shared model-serving process instead
of the task's private model copy. That's the designed path to concurrent
inference within a single task, without needing N copies of the model in
RAM.

**The model server itself is not shipped in this open-source repository.**
`--modelserver` is documented here because it's the direction the
architecture is built for, and because `replicas` is the practical,
supported workaround available in the OSS engine today.

## The old workaround (still works)

Before `replicas` existed, the only way to get concurrent inference was
to manually run N copies of the same pipeline under N distinct
`project_id`s, open N connections, call `use()` N times, and shard
requests across them yourself -- plus manually setting the six BLAS/OMP
env vars per process. This still works today (task identity is
`{owner, project_id, source}`, so distinct `project_id`s always produced
distinct tasks), but `replicas` does the same thing under one token, one
connection, and one `use()` call, with round-robin sharding and env var
injection handled for you.

## Measured impact

From a user report on an AWS `c7i.8xlarge` (32 vCPU), a single task
(`replicas: 1`, default `threads`) processed video at **2.44 frames/s**
while using only **19%** of the 32 vCPUs -- most of the box sat idle
behind the model lock. Running 8 replicas at 4 threads each
(`replicas: 8, torchThreads: 4`) reached **11.07 frames/s** at **75%**
CPU utilization on the same hardware:

| Configuration | Throughput | CPU utilization |
| --- | --- | --- |
| `replicas: 1` (default) | 2.44 frames/s | 19% of 32 vCPU |
| `replicas: 8, torchThreads: 4` | 11.07 frames/s | 75% of 32 vCPU |

Results will vary by pipeline, model, and hardware -- profile your own
workload before picking a `replicas`/`torchThreads` combination for
production.

## See also

- [Engine Reference](README-engine.md) -- `--modelserver` and other CLI
  options, env vars.
- [VS Code Extension](README-vscode.md) -- `rocketride.pipelineReplicas`
  and related settings.
- [Python API Reference](agents/ROCKETRIDE_python_API.md) and
  [TypeScript API Reference](agents/ROCKETRIDE_typescript_API.md) --
  `use()` parameter tables.
- [Common Mistakes](agents/ROCKETRIDE_COMMON_MISTAKES.md) -- Mistake 9,
  starting a pipeline per request.
