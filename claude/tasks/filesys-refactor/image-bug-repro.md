# Image Bug Repro — utf-8 decode error + 0-byte sink files

Date: 2026-08-03 · Branch: `feat/filestore-node` · Verdict: **REPRODUCED** (both symptoms, live engine)

Bug report: UI pipeline `dropper → parse → filestore (sink) → response_json` errors on dropped
images with `'utf-8' codec can't decode byte 0xde in position 5: invalid continuation byte`;
store shows 0-byte `ui-test-out/ocr.jpg` / `ocr_test_mixed.png`. PDFs work.

## TL;DR — two stacked bugs, both confirmed

1. **Primary (why images fail at all):** the filestore sink's streamed-media path
   (`nodes/src/nodes/tool_filesystem/IInstance.py:545-578 _sink_media`) splits
   BEGIN/WRITE/END across **separate `asyncio.run()` loops** (`_run_async`,
   IInstance.py:661), but the aiofiles write handle returned by
   `FileStore.open_write` → `stream_open_write`
   (`packages/ai/src/ai/account/store_providers/filesystem.py:376-380`) is
   **bound to the loop it was created on**. `open_write` runs in loop 1 (closed
   when `asyncio.run` returns); `write_chunk` runs in loop 2 → aiofiles dispatches
   on the dead loop → `RuntimeError: Event loop is closed` → 0-byte file; `close_write`
   fails the same way. The one-shot text path (`_sink_write`, IInstance.py:431 — single
   `_run_async(file_store.write(...))`, whole aiofiles lifecycle inside one loop) is why
   **PDFs/text work and images/audio/video fail**.
2. **Secondary (the utf-8 message the user actually sees):** a **dangling
   `string_view` in the stored C++ error's `Location`**. When the sink's Python
   exception crosses the binder, `call.hpp` builds
   `Location pyloc{excPath, excLineno, excFunction, true}`
   (`packages/server/engine-lib/engLib/python/call.hpp:166`) where `excPath`/
   `excFunction` are **mutable file-scope globals** (call.hpp:35-37, comment:
   "uses string views so they must be 'constant'") and `Location` stores
   `std::string_view m_path / m_function`
   (`packages/server/engine-core/apLib/Location.h:56-61`). binder.cpp stores the FIRST
   failure on the entry (`binder.cpp:141-144`); the run then raises two MORE Python
   exceptions (media END close + parse `closing` flush), each **reassigning the
   globals** (call.hpp:101-102, 154-155) and dangling the stored views. At dropper-pipe
   close, `data_conn.py:816 results['error'] = conn_pipe.entry.completionError` invokes
   the binding at `engine-lib/engLib/store/python/bindings.cpp:651-666`, which converts
   `loc.fileName()` / `loc.function()` (now heap garbage) via `py::str` →
   `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xXX in position N`. The byte is
   **random per run** — observed `0xc9 pos 0`, `0xf3 pos 1`, and the report's `0xde pos 5`
   — the signature of reading freed/reused memory. This raise sits OUTSIDE
   `close_sync`'s try (data_conn.py:811-816), escapes to the relay at
   `packages/ai/src/ai/modules/task/task_engine.py:617`, and lands in the client as the
   pipe-close error the UI displays.

What the prompt's prime suspect predicted (parse text/Text→py::str utf-8 validation) is
**ruled out empirically**: the same image through `filestore_source → parse →
response_text` (no sink) completes 1/1 with clean rich results, and through
`dropper → parse → response_text` the pipe close returns full parse metadata with no error.

## Repro steps (all against live engine, `dist/server/engine ai/eaas.py --host=127.0.0.1 --port=0 --base_port=40100`)

Test image: `testdata/images/ocr.jpg` (10,446 B — the very file family from the bug report;
`ocr_test_mixed.png` also lives there). Driver scripts (scratchpad, session
`f97ca6b9-.../scratchpad/`): `image_repro_driver.py`, `manual_pipe_probe.py`
(Python SDK from `packages/client-python/src`, deps via repo `.venv`).

| Run | Pipe | Result |
|---|---|---|
| `image-src` | `filestore_source(img-repro) → parse → response_text` | **clean** 1/1, no errors — parse alone does NOT reproduce |
| `sink-image` | `filestore_source → parse → filestore(5 lanes) → response_json` | **fails** 0/1: flow trace `filestore_1 lane=image action=1` → `Failed to write chunk to users/local/files/img-repro-out/ocr.jpg: Event loop is closed`; then close → `Close failed after 0 bytes; file state indeterminate`; **0-byte ocr.jpg in store** |
| `dropper-image` | `dropper → parse → filestore → response_json` + `send_files(ocr.jpg)` | upload result `action: error`, `error: "'utf-8' codec can't decode byte 0xc9 in position 0: invalid continuation byte"`; same Event-loop-is-closed flow errors + 0-byte file — **full UI symptom reproduced** |
| `dropper-nosink` | `dropper → parse → response_text` + same image | **clean**: `action: complete`, close returns full parse metadata (JPEG component info etc.), 1/1 |
| manual probe | same sink pipe, raw `pipe.open/write/close` | `pipe.close()` raises `PipeException`, dap_result: `{"success": false, "message": "'utf-8' codec can't decode byte 0xf3 in position 1: invalid continuation byte", "trace": {"file": "task_engine.py", "lineno": 617}}` |

### Flow trace of the failing object (run log `filestore_source_1.dev.000001.jsonl`, project `7c1d9e42-…`)

```
134 enter parse_1     closing
135 enter filestore_1 image  {action:0(BEGIN), bufferSize:290, mime:image/jpeg}   → continue
137 enter filestore_1 image  {action:1(WRITE), bufferSize:10446}
138 leave filestore_1 image  ERROR Failed to write chunk to users/local/files/img-repro-out/ocr.jpg: Event loop is closed
139 enter filestore_1 image  {action:2(END)}
140 leave filestore_1 image  ERROR Close failed after 0 bytes; file state indeterminate: ... Event loop is closed
141 leave parse_1     closing ERROR Failed to write chunk ... Event loop is closed
```

Three Python exceptions per object = the globals-reassignment count needed for bug 2.

### Exact traceback surface (the utf-8 error)

No Python traceback is printed (raised inside the task subprocess's threaded
`close_sync`, wrapped into a failed DAP response). The captured server error envelope:

```
PipeException: 'utf-8' codec can't decode byte 0xf3 in position 1: invalid continuation byte
dap_result = {"type": "response", "seq": 5, "request_seq": 5, "command": "rrext_process",
              "success": false,
              "message": "'utf-8' codec can't decode byte 0xf3 in position 1: invalid continuation byte",
              "trace": {"file": "task_engine.py", "lineno": 617}}
```

Raise chain: `data_conn.py:816 entry.completionError` → `bindings.cpp:663-664
py::str(loc.fileName()/loc.function())` [dangling string_view] → UnicodeDecodeError →
escapes `_close` (outside the try at data_conn.py:790-805) → relayed by
`task_engine.py:616-617 raise RuntimeError(response.message)` → client `pipe.close()`.

## Minimal failing payloads

- **Pipeline-level:** any real image through `parse → filestore` media lanes;
  `testdata/images/ocr.jpg` via `send_files` on the dropper sink pipe is the exact UI case.
- **Primary bug, 6-line standalone proof** (no engine needed; repo `.venv`):

```python
import asyncio, aiofiles
async def op():  return await aiofiles.open('/tmp/x', 'wb')
h = asyncio.run(op())                      # loop 1 — closed on return (= sink BEGIN/first WRITE open)
asyncio.run(h.write(b'abc'))               # loop 2 → RuntimeError: Event loop is closed
asyncio.run(h.close())                     # → RuntimeError: Event loop is closed
# result: /tmp/x exists with size 0  — identical 0-byte artifact
```

## Failing components (file:line)

| # | Component | Location |
|---|---|---|
| 1 | filestore sink media streaming — cross-loop aiofiles handle | `nodes/src/nodes/tool_filesystem/IInstance.py:570-577` (`_sink_media` open/write/close via separate `_run_async` loops, `_run_async` at :661) with `packages/ai/src/ai/account/store_providers/filesystem.py:380` (`stream_open_write` returns loop-bound aiofiles handle) |
| 2 | dangling error-location string_views | `packages/server/engine-lib/engLib/python/call.hpp:35-37,101-102,154-155,166` (mutable globals + `Location pyloc{excPath,…}`) + `packages/server/engine-core/apLib/Location.h:59-61` (`string_view` members) + `packages/server/engine-lib/engLib/store/python/bindings.cpp:663-664` (`completionError` → `py::str`) surfacing at `packages/ai/src/ai/modules/data/data_conn.py:816` |

## Root-cause statement

Dropped images 0-byte + error because the filestore sink streams media through a fresh
`asyncio.run()` loop per lane callback while the FileStore aiofiles write handle stays
bound to the (already closed) loop that opened it — every chunk write and the close raise
`RuntimeError: Event loop is closed`, leaving the opened file at 0 bytes. The bizarre
`'utf-8' codec can't decode byte …` the user sees is a second, masking bug: the entry's
stored completion error holds `Location` string_views into the mutable globals
`excPath`/`excFunction` (call.hpp), which the run's subsequent Python exceptions
reassign; reading `entry.completionError` at dropper-pipe close then converts dangling
heap memory to `py::str` and raises UnicodeDecodeError with a run-random byte, replacing
the real error message. PDFs escape both because text/documents lanes use the one-shot
`_sink_write` (single loop for the whole aiofiles lifecycle).

## Not verified / open

- Did not run `ocr_test_mixed.png` (jpg deemed sufficient; PNG follows the identical media lane).
- Bug 2's dangling-view mechanism is confirmed by type inspection (string_view members,
  mutable globals, 3 reassigning exceptions per object) plus the run-random garbage byte;
  a C++-level watchpoint was not taken (would require an instrumented build — out of
  scope for diagnosis-only).
- The prompt's step-5 latin-1 `.txt` bisect was unnecessary — the Text→py::str theory was
  disproven by the clean no-sink runs.

## Cleanup

Seeded store files removed (`img-repro/`, `img-repro-out/`); pre-existing `ui-test-out/`
(user's own 0-byte artifacts) left untouched. Engine PID 52962 stopped. Drivers + raw
captures (`run_*_events.json`, `run_*_summary.json`, `engine.log`) remain in the session
scratchpad only; nothing touched production code or git.

## Fix verification

Date: 2026-08-03 · Commit: `cd41c566` (`_run_on_stream_loop`, single persistent event-loop
thread for handle-based store ops) · Verdict: **VERIFIED — bug reproduced-then-gone**

### Dist sync (required this time)

`dist/server/nodes/tool_filesystem/IInstance.py` was stale — still had the old per-call
`_run_async` for `open_write`/`write_chunk`/`close_write`, no `_run_on_stream_loop` at all.
Ran `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:$PATH" arch -arm64
./builder nodes:build` → `nodes:sync` reported "~1 updated, 1059 unchanged"; post-build
`diff nodes/src/nodes/tool_filesystem/IInstance.py dist/server/nodes/tool_filesystem/IInstance.py`
→ identical, `_run_on_stream_loop` present (6 call sites) in both. (Contradicts the fix-wave
note in `smoke-report.md` that dist sync is unnecessary — that held for the D1/D2/D3 wave
because the engine imported unchanged files; the loop fix genuinely required a fresh sync.)

### Setup

Fresh engine: `dist/server/engine ai/eaas.py --host=127.0.0.1 --port=0 --base_port=40200`,
bound `http://127.0.0.1:54432` (PID 56972). SDK driver reused/adapted from this repro
(`image_repro_driver.py`, repointed at the new port) plus a new `text_repro_driver.py` for
the regression check. Scratchpad `fixverify/`.

### Image lane (the bug's exact repro) — `filestore_source(img-repro) → parse →
filestore(5 lanes, targetDir img-repro-out/) → response_json`

- Seed: `img-repro/ocr.jpg`, 10446 B written.
- Task: `state: 6, completed: true, warnings: [], errors: [], totalCount: 1,
  completedCount: 1, failedCount: 0` (exitCode still 1 — the known pre-existing
  `task_engine.py:1304` exitCode-key harness bug, unrelated, out of scope).
- Flow trace: BEGIN (action:0) → WRITE (action:1, bufferSize:10446) → END (action:2), all
  `result: continue`, zero errors between them — no `Failed to write chunk`, no `Close
  failed`, i.e. the exact sequence that previously errored twice per object now clears.
  `response_json_1` received `{"path": "img-repro-out/ocr.jpg", "url":
  "http://127.0.0.1:40201/task/fetch?token=..."}` — JSON ref confirmed on the json lane.
- Stored file: `~/.rocketlib/store/users/local/files/img-repro-out/ocr.jpg` = 10446 B,
  SHA-256 `a1a3b5fc...09be9` — **byte-identical** to `testdata/images/ocr.jpg` (same hash).
  Previously this was 0 bytes.
- `grep -c "Event loop is closed"` on both the captured event JSON and the full engine
  log: **0** in both.

### Text lane regression check — `filestore_source(txt-repro) → parse →
filestore(text lane only, targetDir txt-repro-out/) → response_json`

- Seed: `txt-repro/note.txt`, 66 B (`MARKER-TEXT-REPRO-1: the quick brown fox jumps over
  the lazy dog.\n`).
- Task: `state: 6, completed: true, warnings: [], errors: [], totalCount: 1,
  completedCount: 1, failedCount: 0`.
- Stored file: `txt-repro-out/note.md` (parse's text lane always emits `.md`, not a
  regression), 67 B — content identical to the seed (parse just normalizes to markdown
  text; no byte corruption). `grep -c "Event loop is closed"` → 0. Confirms the one-shot
  `_sink_write` path (untouched by this fix) still works.

### Cleanup

Store files deleted via `fs_delete` (`img-repro/ocr.jpg`, `img-repro-out/ocr.jpg`,
`txt-repro/note.txt`, `txt-repro-out/note.md`); the four now-empty seed/output
directories (each held only an internal `.dirmarker`) removed directly since `fs_delete`
on a directory raises `Operation not permitted` by design. Engine PID 56972 killed and
confirmed gone. Drivers + captures left in session scratchpad only
(`fixverify/image_repro_driver.py`, `fixverify/text_repro_driver.py`,
`fixverify/run_*_events.json`, `fixverify/engine.log`); nothing staged or committed,
`pipelines/` untouched.
