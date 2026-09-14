<!--
MIT License

Copyright (c) 2026 Aparavi Software AG

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->

# GA checks — rocket-agent

Executable GA-signoff checklists, run BY HAND against a real STAGING deployment. None of the
scripts in this directory are executed by Claude, run in CI, or safe to point at production.

| Script                | Task  | What it checks                                                                 |
| ---------------------- | ----- | -------------------------------------------------------------------------------- |
| `quotas.sh`             | 5.2b  | Session-cap 429, MCP rate-limit 429 (+ idle-TTL / retention reminders)          |
| `pentest.sh`            | 5.2c  | Egress/SSRF/metadata, cross-session isolation, tool lockdown, key grep          |
| `lockdown-probe.mjs`    | 5.2c  | Helper `pentest.sh` Check 3 calls — prompts a live session to attempt 3 locked-down actions and polls the transcript for denial |

## Why some of this can't run locally or in CI (read this before asking "why didn't Claude just run it")

`pentest.sh`'s egress checks (Section 1) exist to prove **CiliumNetworkPolicy** — see
[`k8s-apps/rocket-agent/networkpolicy.yaml`](../../../../k8s-apps/rocket-agent/networkpolicy.yaml)
— actually blocks arbitrary internet/SSRF/cloud-metadata egress from a live pod, and still lets
inference traffic through. That policy is enforced by the cluster's CNI at the kernel/eBPF
level; there is no local, offline, or CI-runnable substitute for it. Running this section
anywhere other than a real Cilium-enabled cluster will **silently pass every check for the
wrong reason** (nothing is blocking anything, including the "should be blocked" cases) — so
don't run it anywhere else and treat the result as meaningful.

`lockdown-probe.mjs` (Section 3) needs a real, pinned opencode binary running a real model turn
behind a live staging session — the whole point is proving the *actual* running process
enforces `config/opencode-locked.json`'s deny wall, not a mock of it.

**What IS run locally/in CI, and genuinely proves the key-redaction half of this task:**
[`../../tests/redaction.test.ts`](../../tests/redaction.test.ts) — a real `SessionManager` +
`createApp()` + fake HTTP upstreams (no opencode binary, no cluster, no live key), with a
realistic-looking key planted in the key resolver, asserting the key substring appears in NONE
of: logger output, session records, audit records, SSE panel-event payloads, or HTTP response
bodies — plus a grep-level check that no `src/` module outside `src/log.ts` calls the raw
`console.*` at all. `pentest.sh`'s Section 4 (key grep against staging logs/workspaces) is the
**black-box confirmation of the exact same invariant against the real deployed edge** — the
local test is the load-bearing, CI-enforced evidence; Section 4 is "and it also holds true in
the real environment," not a replacement for it.

## Prerequisites

- `kubectl` context pointed at the staging cluster, namespace `rocketride`.
- `curl` (with `--path-as-is` support — any curl >=7.42 has it).
- `node` (>=20) for `lockdown-probe.mjs`.
- Two DISPOSABLE staging test users/tenants (A and B — **different tenants**, so the
  cross-session checks are meaningful) with valid bearer tokens, each with at least one live
  rocket-agent session already created.
- `jq` optional (both scripts degrade gracefully without it).

## Running `pentest.sh`

```bash
NAMESPACE=rocketride \
BASE=https://agent-staging.rocketride.ai \
AGENT_INTERNAL=http://rocket-agent.rocketride.svc.cluster.local:8790 \
TOK_A=<bearer token, disposable staging user A> \
TOK_B=<bearer token, disposable staging user B, DIFFERENT tenant> \
SID_A=<a session id already created + live for user A> \
SID_B=<a session id already created + live for user B> \
./pentest.sh
```

`AGENT_INTERNAL` must be reachable from wherever you run the script — `/internal/mcp/*` is
never routed at the edge (see `src/index.ts`'s route comment), so either run this from a debug
pod inside the `rocketride` namespace, or `kubectl port-forward svc/rocket-agent 8790:8790`
first and point `AGENT_INTERNAL` at `http://127.0.0.1:8790`.

`./pentest.sh -h` prints the full usage/env-var reference. Exit code is non-zero on the FIRST
`FAIL` — the script stops immediately rather than running every check against a cluster already
known to be in a bad state.

## Running `lockdown-probe.mjs` directly

`pentest.sh`'s Check 3 calls this automatically (set `RUN_LOCKDOWN_PROBE=0` to skip it and run
by hand instead):

```bash
BASE=https://agent-staging.rocketride.ai \
TOK_A=<bearer token, disposable staging user A> \
SID_A=<a session id already created + live for user A> \
SID_B=<a session id already created + live for user B> \
node lockdown-probe.mjs
```

It prompts session A's agent to (a) run a shell command, (b) read session B's workspace, and
(c) fetch a URL — then polls the transcript and reports `PASS`/`FAIL`/`WARN inconclusive` per
action. `WARN inconclusive` means the model never cleanly attempted that action; re-run with a
longer `TIMEOUT_MS` or treat the prompt wording as needing a tune-up before signing off on
tool lockdown — it is NOT a pass.

## Results table — paste into the 5.2e launch checklist

| Check | Result | Notes / evidence |
| --- | --- | --- |
| 1a. Arbitrary egress blocked | PASS / FAIL | |
| 1b. api.anthropic.com reachable | PASS / FAIL | |
| 1c. Cloud metadata endpoint blocked | PASS / FAIL | |
| 2a. Cross-session read denied | PASS / FAIL | |
| 2b. Wrong MCP secret rejected | PASS / FAIL | |
| 2c. Path traversal rejected | PASS / FAIL | |
| 3. Tool lockdown (bash / external_directory / webfetch) | PASS / FAIL / INCONCLUSIVE | attach `lockdown-probe.mjs` output |
| 4a. rocket-agent log grep clean | PASS / FAIL | |
| 4b. rocketride-eaas log grep clean | PASS / FAIL | |
| 4c. On-disk workspace grep clean | PASS / FAIL | |
| Local: `tests/redaction.test.ts` | PASS / FAIL | paste `pnpm --filter rocket-agent test` output |

Run date: __________  Cluster: __________  Operator: __________

Any `FAIL` above is a GA blocker: fix, then re-run the WHOLE script (not just the failed
check) — a fix for one check can regress another.
