# Local CPU inference slots

In local mode (no `--modelserver`) a task runs its models inside its own process.
On a GPU, `ai.common.models.device_budget` admits a call when its memory fits. On
the CPU the same module keeps one count of calls for the whole process: its CPU
slots. A model class that wants more than one call at a time on the CPU asks for
a place there, so the further calls of several models never add up to more than
the slots (each model's first call enters beyond them).

## The rule

Each call names the model copy it runs on (`model`) and how many calls of that
model may be inside at once (`calls`). Calls that name no model share one group.

1. A model's first call enters at once. It never waits for another model's calls.
   This is the model's own slot, and it is what the old per-model lock gave.
2. A further call of the same model enters while that model has fewer than
   `calls` inside and the process has fewer calls inside than its slots. First
   calls of every model count in that total.
3. Calls of one model enter in arrival order. Calls waiting for a free slot enter
   in arrival order across models. A call that waits only because its own model
   is at its limit does not hold back a later call of another model. A call
   whose model has no call inside enters as that model's first call even while
   an earlier call of another model waits for a slot.

With one slot, every model runs one call at a time, as before.

Because a first call always enters, a task with more models than slots has more
calls inside than slots. Only the further calls of a model are limited.

## How many slots

The usable cores are the fewest of:

- the physical cores (`psutil`, SMT siblings not counted),
- the CPUs the process may run on (its affinity on Linux, else all CPUs). These
  are logical CPUs, SMT siblings included, so with a cpuset narrower than the
  physical cores the count can include siblings,
- the container's CPU quota (cgroup v2 `cpu.max` or v1 `cpu.cfs_quota_us`),
  rounded up to whole CPUs.

A value that cannot be read is skipped. The process gets one slot per 4 usable
cores, at least 1 and at most 4. The task logs the count once, when the CPU guard
is created.

The operator can set `RR_CPU_INFERENCE_SLOTS` to a whole number from 1 to 16 in
the engine's environment; tasks inherit it. `RR_CPU_INFERENCE_SLOTS=1` restores
the old behaviour: one call at a time per model. A value outside that range is
logged as a warning and the computed count applies.

## Which models use it

- The sentence-transformer embedding model, on the local CPU path only. A stock
  Hugging Face `BertModel` encoder (both MiniLM profiles of
  `embedding_transformer`) asks for up to 4 calls. The check reads the loaded
  model once: evaluation mode, torch and BERT modules only, no hooks or replaced
  `forward`, float32 CPU tensors. Any other embedding model asks for 1.
- OCR (EasyOCR, docTR, Surya, TrOCR) names no model, so it stays at one call at a
  time on the CPU across all OCR nodes, as before. An OCR call never waits for
  the embedding model, and the embedding model's first forward never waits for
  OCR; its further forwards count the OCR call inside.

## What does not change

- GPUs keep the memory rule; `model` and `calls` are ignored there.
- `mps` and any other non-CUDA device keep one slot.
- With `--modelserver` the guard admits every call and the model server keeps its
  own dispatch; the embedding model keeps its per-model lock there.
- A hosted engine's tasks (`--hosted`) never install or import torch, so they
  never run a model in-process and never take this path.

## Known limits

- Each task process has its own count. Two tasks on one machine can each use
  their full count.
- There is no RAM check on the CPU. More calls at once means more activations in
  memory at once.
- The number of torch threads per call is not changed. Calls at once share the
  same cores.
- The quota is read at the cgroup mount root, which is the container's own limit
  inside a container. A quota set on a host process through a nested cgroup (a
  systemd slice) is not seen.
- Process affinity is not read on Windows; there all CPUs count.

## Adding a model class

In the local path of the class in `ai/common/models`, run the forward inside
`device_budget(device).reserve(cost_mb, model=<the loaded model>, calls=<n>)`.
Ask for more than 1 only when the forward is known to leave the model unchanged,
and add a test that compares outputs of calls run at once with serial ones (see
`test_sentence_transformers_cpu_real.py`). With `--modelserver` the guard is a
no-op, so keep the class's own lock on that path.
