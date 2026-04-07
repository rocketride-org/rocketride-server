# Dev A Testing Plan — `visual_similarity_filter`

## Context

Dev A's work is the `visual_similarity_filter` node. It upgrades VSF from a passive
data-plane filter to a control-plane oracle that `clip_buffer` (Dev B) calls via
`invoke()` to ask "does this frame contain the car?".

This plan covers everything that can be tested **without Dev B** — Modules 1–4.
Module 5 is blocked on Dev B's `clip_buffer` node.

---

## Test Assets

| File                                                              | Role                                            |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `f1-saas-app/test/F1_dpa-1.jpg`                                   | Reference car image (768×511, overhead shot)    |
| `f1-saas-app/test/FIA_F1_Austria_2021_Nr._44_Hamilton_(side).jpg` | Different car/angle (4644×2612, side profile)   |
| Synthetic solid black PNG (generated in test)                     | Non-matching frame — should always return False |

---

## Module 1 — Contract Test

**No engine. No GPU. Instant.**

Validates that `services.json` is correctly structured so the engine can register
the node without errors.

### What is checked

- `title`, `protocol`, `prefix` fields exist
- `classType` contains `"visual_similarity"` (required for clip_buffer addressing)
- `capabilities` contains `"invoke"` (required for control-plane invocation)
- `invoke` block is present
- `lanes` is empty `{}` (VSF has no data lanes in new architecture)
- `preconfig.default` profile exists

### Run

```bash
cd /Users/shashidharbabu/rocketride-server
./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py::TestVSFContract -v
```

### Pass criteria

All assertions green, zero errors.

---

## Module 2 — FrameEmbedder Unit Test

**No engine. Requires CLIP download (~600MB, one-time).**

Tests the raw CLIP embedding logic in `frame_embedder.py` directly.

### Test cases

| ID  | Description                                              | Expected                             |
| --- | -------------------------------------------------------- | ------------------------------------ |
| 2.1 | `augment_reference(f1_dpa.jpg)` returns an embedding     | numpy array, not None                |
| 2.2 | Embedding is unit-normalised                             | `np.linalg.norm(emb) ≈ 1.0 (±0.001)` |
| 2.3 | `embed_patches(f1_dpa.jpg)` returns same-shape embedding | shape matches reference              |
| 2.4 | `score(ref, same_image)` is near 1.0                     | score ≥ 0.99                         |
| 2.5 | `score(ref, black_frame)` is low                         | score < threshold (0.25)             |
| 2.6 | `score(ref, hamilton_side.jpg)` returns a float          | -1.0 ≤ score ≤ 1.0                   |

### Run

```bash
./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py::TestFrameEmbedder -v
```

---

## Module 3 — IInstance.invoke() Lifecycle Test

**No engine. Requires CLIP (shared with Module 2).**

Tests the full `invoke()` state machine using a real `IGlobal` + `FrameEmbedder`
(no mocks — we want to test the real code path).

### Test cases

| ID  | Description                                                     | Expected                                           |
| --- | --------------------------------------------------------------- | -------------------------------------------------- |
| 3.1 | First `invoke()` — reference is None                            | Returns `True`, `reference_patches` is set         |
| 3.2 | First `invoke()` sets reference to correct embedding            | `reference_patches` shape matches direct embedding |
| 3.3 | Second `invoke()` with same image as reference                  | Returns `True` (score ≥ threshold)                 |
| 3.4 | `invoke()` with solid black frame after reference set           | Returns `False` (score < threshold)                |
| 3.5 | Thread safety — 10 threads call first `invoke()` simultaneously | `reference_patches` set exactly once               |

### Run

```bash
./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py::TestIInstanceInvoke -v
```

---

## Module 4 — Live Engine Registration Test

**Requires engine running at localhost:5565.**

Verifies VSF is discoverable and loadable in the actual engine.

### Start engine

```bash
cd /Users/shashidharbabu/rocketride-server/dist/server
./engine ai/eaas.py --port=5565
```

### Test cases

| ID  | Description                                             | Expected                                  |
| --- | ------------------------------------------------------- | ----------------------------------------- |
| 4.1 | Load a pipeline containing `visual_similarity_filter_1` | No `InvalidName` error                    |
| 4.2 | VSF node appears in engine node registry                | `visual_similarity` classType addressable |

### Run

```bash
./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py::TestVSFEngineRegistration -v
```

---

## Module 5 — End-to-End Pipeline Test

**BLOCKED — requires Dev B (`clip_buffer`) + `frame_grabber` scene_score changes.**

When unblocked:

1. Start engine with new `demo.pipe.json`
2. POST `video-proof.mp4` + `F1_dpa-1.jpg` via `client.sendFiles()`
3. Assert response contains MP4 video output
4. Assert response contains timestamps table
5. Assert output MP4 is shorter than input (only matched clips)

---

## How to Run All Available Modules

```bash
cd /Users/shashidharbabu/rocketride-server

# Modules 1-3 (no engine needed)
./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py -v \
  -k "not EngineRegistration" \
  --tb=short

# Module 4 (engine must be running)
./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py::TestVSFEngineRegistration -v
```

---

## What a Broken Dev A Looks Like

| Symptom                                                                         | Root cause                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Engine exits with `InvalidName: name not found in services.json`                | `services.json` missing required field                     |
| `clip_buffer` errors: `getControllerNodeIds('visual_similarity')` returns empty | `classType` missing `"visual_similarity"` in services.json |
| Every frame matches (all True)                                                  | Reference set incorrectly — comparing reference to itself  |
| Nothing ever matches (all False)                                                | Threshold too high, or embedder broken                     |
| Intermittent crashes under load                                                 | Thread-safety bug in double-checked lock                   |
| Engine silently exits on startup                                                | `services.json` JSON parse error                           |
