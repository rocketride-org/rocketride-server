# Dev-hang probe — project 9f3b7e21, chapter 3 (beginSeq 1437, ~12:54)

Date: 2026-08-03 · READ-ONLY probe of the live engine (PID 70504, ws://localhost:5565).
Method: Python SDK (`packages/client-python/src`, run under `dist/server/python`; `ROCKETRIDE_URI=http://127.0.0.1:5565`, `ROCKETRIDE_APIKEY=MYAPIKEY`) → `client.log.read(project, 'filestore_source_1', 'dev', from_seq=1437)` (`rrext_log` subcommand `read`). The active segment (id 2) has no `.jsonl` in `.logs/` because it lives in the writer's spool; the reader composes store+spool+active, so the whole chapter came back in one page: **384 events, seq 1437→2201** (raw dump: scratchpad `chapter_events.json`, probe: scratchpad `probe.py`). No task was triggered; nothing written to the engine.

## Chapter shape

- 1437–1633: `apaevt_log_lifecycle` run-begin (traceLevel `full`), `apaevt_task` begin, then console output = dependency installs only. Two real installs: `cython/safetensors/versioneer` (nodes requirements, seq 1553–1568) and **`imageio-ffmpeg==0.6.0` (packages/ai `common/avi/requirements.txt`, seq 1620–1632)** — the avi handler dep, pulled in for the `.mp4`. Console output STOPS at 1633 and never resumes.
- 1637–1732: all 92 `apaevt_flow` events (6 objects, pipe ids 0–5).
- 1734: `apaevt_status_object` `{object: "filestore_source://fs/ui-test-out/ocr.jpg", size: 0}` — the LAST non-status event of the chapter.
- 1735–2201: nothing but periodic `apaevt_status_update`. The run is idle-hung: no flow, no console, no errors since 1732.

## 1. Hung objects — exact flow sequences (verbatim seq/op/component/lane/result)

`minimal.md` (pipe 2):
```
1639 begin
1640 enter response_text_1 lane=open        1645 leave (continue)
1646 enter parse_1        lane=open        1648 leave (continue)
1695 enter parse_1        lane=tags        1697 leave (continue)
1708 enter parse_1        lane=tags        1709 leave (continue)
1712 enter parse_1        lane=tags        1713 leave (continue)
1722 enter parse_1        lane=tags        1731 leave (continue)   <- last event ever
```
`CA SSA (US SSN) Match.md` (pipe 1): identical shape — open pair on response_text_1 (1643/1652) and parse_1 (1653/1654), then 4 tags pairs (1686/1687, 1691/1692, 1701/1702, 1707/**1730**). `chinese.png` (pipe 3): same — open pairs (1647/1662, 1663/1664), 4 tags pairs (1688/1689, 1705/1706, 1714/1715, 1727/**1732**).

Findings:
- **No `closing` lane, no `close` lane, no flow op `end` — ever** — for any hung pipe. The `sendClose()` the node now issues never manifested as a lifecycle-lane traversal on these pipes. Either it was never reached in `renderStoreObject`, or its dispatch is stuck behind something; the event stream proves it did not execute engine-side.
- Each hung object delivered only **4 tags frames** (completed objects get 5 — the 5th frame never arrived, i.e. the render's final `sendTag*` and everything after it are missing).
- The 4th tags frame of each hung object was **held open for a long span then released**: enter 1707/1708/1714/1722 → leave only at 1730/1731/1732, interleaved AFTER ocr.jpg's `end` (1729). Those three leaves are the final flow events of the chapter.
- `BBC - Tear down this wall.mp4` (pipe 0) is the worst case: begin 1637, open pairs only (response_text_1 1641/1649, parse_1 1650/1651) — **zero tags frames**. Its render never delivered a single data frame. The imageio-ffmpeg install (seq 1620–1632) immediately precedes the flow block; the mp4 render/avi path is the prime suspect for what everything is wedged behind.
- Live `pipeflow.byPipe` confirms idleness, not busyness: pipes 0–3 each show stack `["<object name>"]` — the object frame open, **no component currently executing**. Pipes 4/5 (completed) are `[]`.

## 2. Completed objects (ocr.jpg pipe 5, ocr_test_mixed.png pipe 4) — what made them end

Both 0-byte; parse excludes them: `apaevt_status_warning` seq 1660/1667 `Excluded*Skipping ocr_test_mixed.png|ocr.jpg because the file is empty*parse-instance.cpp:626`.

`ocr.jpg` sequence (ocr_test_mixed.png identical, seqs 1644–1700):
```
1655 begin
1657/1665 enter/leave response_text_1 open (continue)
1666/1668 enter/leave parse_1        open (continue)
5 × enter/leave parse_1 tags (1693/1694, 1696/1698, 1703/1704, 1710/1711, 1716/1717) all continue
1718/1719 enter/leave parse_1         closing (continue)
1720/1721 enter/leave response_text_1 closing (continue)
1723/1724 enter/leave parse_1         close   (continue)
1725/1726 enter/leave response_text_1 close   (continue)
1729 end
```
So: **all 5 tag frames arrived, then a full `closing` → `close` lifecycle dispatch (parse_1 first, then response_text_1, i.e. upstream-first as documented), and `end` is emitted by the engine right after the downstream component's `close` leave.** This is exactly the path the hung objects are missing from frame 5 onward. Note the 0-byte objects were the LAST two begun (1644, 1655) yet the only ones to finish — completion order is not begin order; their renders/closes ran while the others' finals never came.

## 3. Errors / tracebacks / warnings in this chapter

- **Zero Python tracebacks, zero error events.** `errors: []` in every status snapshot; `exitCode: 0`, `exitMessage: ""`, state stays 3 (RUNNING), `completed: false`.
- Only warnings: the two `parse-instance.cpp:626` empty-file exclusions above.
- Console output is exclusively dependency-install logging (uv dry-runs mostly no-ops; the two installs listed above) plus uvicorn startup on :20000. Nothing after seq 1633.
- Oddity worth noting: `totalCount / completedCount / failedCount` are all **0** in every snapshot despite 6 objects begun and 2 fully ended — the scan counter has not registered anything (either `scanObjects`' scanCallback reporting hasn't run/flushed yet, or counts only post at scan completion). `status` is stuck at `" + imageio-ffmpeg==0.6.0"` and `currentObject` at `filestore_source://fs/ui-test-out/ocr.jpg` (size 0) since 1734.

## Net read

The two 0-byte objects prove the full contract path works end-to-end (5 tag frames → closing/close → end). Every non-empty object stops after its 4th tags frame with no close and no error; the mp4 never even started emitting tags, right after its handler dep was installed. The stall pattern (final frames of ALL non-empty renders missing simultaneously, engine idle, no active component on any pipe) points at the render side never delivering the final frame + `sendClose` — consistent with the renders being serialized/wedged behind the mp4 read in the source node's render path, rather than at parse or the engine dispatcher.
