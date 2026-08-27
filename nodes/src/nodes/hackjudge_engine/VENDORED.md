# hackjudge_engine — vendored engine provenance

The deterministic verification engine under `_engine/` is **vendored** from the
Hack Judge app repo (`hackathon-usage-verifier`). It is copied in (not imported by
path) so the node is self-contained inside the server tree.

## What is vendored (and from where)

| File in `_engine/` | Source (`hackathon-usage-verifier/`) | Verbatim? |
| --- | --- | --- |
| `engine.py` | `eval/engine.py` | Copy + 2 patched lines (below) |
| `target.py` | `eval/target.py` | Verbatim |
| `targets/*.json` | `eval/targets/*.json` | Verbatim |
| `fetch.py` | extracted from `run_batch.py` | Minimal subset (stdlib only) |

## The two patches applied to `engine.py`

Both are import-only; no logic changes, so the verdict is identical:

1. `from target import Target, load_preset` → `from .target import Target, load_preset`
   (relative import, since the code now lives in the `_engine` subpackage).
2. `import run_batch as rb` → `from . import fetch as rb` (both occurrences).
   The engine only uses `rb.parse_repo` and `rb.OTHER_PLATFORMS`; `fetch.py`
   provides both. This avoids pulling in `run_batch`'s `openpyxl` / `rocketride`
   dependencies.

## Resync when the source engine changes

Re-copy `eval/engine.py`, `eval/target.py`, `eval/targets/` from the app repo,
then re-apply the two `engine.py` patches. Parity is verified by running the app's
`eval/run_eval.py` fixtures against `_engine/` and by the node parity harness.

`fetch.py` is a hand-maintained subset — if `run_batch._gh` / `parse_repo` /
`repo_missing` / `github_token` / `OTHER_PLATFORMS` change, update `fetch.py` too.
