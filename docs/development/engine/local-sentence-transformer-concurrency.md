# Local CPU SentenceTransformer concurrency

The local `embedding_transformer` path uses `SentenceTransformer.encode()` and
`SentenceTransformerLoader.inference()`. Only the transformer forward shares
model state. Tokenization, tensor movement, pooling, normalization and output
ordering remain outside the forward gate.

## Admission rule

At the first local CPU forward, the loader checks the actual loaded transformer.
A native Hugging Face `BertModel` encoder in evaluation mode, with CPU FP32
floating-point parameters and buffers, may run **two forwards per model** at
once. Its submodules must come from the standard BERT/PyTorch implementations,
remain in evaluation mode, and have no instance-level replacement `forward` or
forward hooks. Decoder/cross-attention configurations remain exclusive.

The rule does not inspect CPU vendor, processor model, core count, RAM size,
package versions or model repository name. Both MiniLM profiles built on native
BERT can qualify; a local directory containing the same implementation can also
qualify. MPNet and custom implementations such as NomicBert keep the existing
per-model lock until separately reviewed and tested.

The private loaded model must not be trained, moved to another device or modified
after first use. Such mutations already conflict with concurrent pipeline use;
the qualification check is not a sandbox for arbitrary custom Python code.

## Ownership and compatibility

- The loader's existing per-model registry owns either a `Lock` or a
  `BoundedSemaphore(2)`. Admission is selected once; a live gate is never resized.
  If the check itself fails, the model keeps one forward at a time and a warning
  is logged; the forward does not fail.
- `ROCKETRIDE_DISABLE_LOCAL_CPU_CONCURRENCY=1` (or `true`, `yes`, `on`) restores
  one forward at a time per model. It is read when a model's gate is created, at
  its first local forward, so set it before the task starts. An unrecognized
  value also keeps one forward at a time and logs a warning.
- The worker holds its permit around the synchronous forward, under that
  worker's `torch.no_grad()`. The context manager releases it on success or
  exception. A caller timeout or cancellation does not release a running
  worker's permit.
- Unsupported models retain their own lock. Independent models can overlap,
  including when both are unsupported. OCR keeps its existing `DeviceBudget`;
  this change does not make OCR wait for embeddings.
- The semaphore is enabled only by the local encode path on CPU. Fresh
  model-server models, direct loader calls and CUDA/MPS inference retain the
  original exclusive policy. Models belong to their loading/execution path;
  sharing a loaded instance between local and server execution is unsupported.
- Existing queue-wait accounting records time waiting for either kind of gate.
  Weak-reference cleanup removes a retired model's registry entry.
- Two overlapping forwards each take longer than one alone, and each records
  its own elapsed time in `gpu_compute`, so the summed `gpu_compute` of a run
  rises even when the run finishes sooner. `gpu_memory` (model size times each
  call's inference time, queue wait included) can move either way: it falls
  when overlap removes queueing, and it can rise slightly when two calls that
  would have waited little overlap and each run longer.
- There is no new node setting, thread pool, process-wide controller, memory
  sampler or change to PyTorch intra-op/inter-op thread settings.

## Capacity and validation

Two is an initial conservative concurrency choice, not an estimate of available
CPU or RAM and not a claim that two is fastest on every machine. Independent
models each have their own allowance. More overlap can increase CPU work and
peak memory; this change does not reserve resources across models or processes.
A process-wide budget belongs in a separate `DeviceBudget` change with its own
mixed-workload and fallback tests.

The focused suite covers bounded overlap, independent models, OCR coexistence,
exclusive unsupported/server/device paths, exception cleanup, caller timeout,
registry cleanup and queue-wait accounting. Offline real-BERT tests compare
mixed-size concurrent requests against serial execution and check that shared
weights and buffers are unchanged. They skip when the optional ML dependencies
are unavailable; skip counts must be reported.

Before release, run stock versus the candidate on the same corpus with 2, 4, 8,
16 and 24 allocated CPUs, each as a CPU set and as a CPU quota, including
two-versus-four-slot diagnostic variants. Two and four CPUs matter most: there
one forward can already fill the machine.
Keep math-thread settings unchanged and recorded. Measure unprofiled throughput,
latency, CPU and peak memory; use RocketRide profiling in separate matched
diagnostic runs. Validate all output vectors and their ordering, mixed OCR plus
embedding, multiple models, long-running workloads and memory pressure. Those
measurements decide whether to retain or revise the automatic allowance; they
must not become a hardware fingerprint in the eligibility check.
