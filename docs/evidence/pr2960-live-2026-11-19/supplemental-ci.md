# PR 2960 supplemental CI and policy evidence

Recorded UTC: 2026-11-19T09:01:09.535751+00:00. Exact PR head: `7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b`.

Current rollup: **29 success, 4 skipped**, 0 other outcomes. This includes repeated bot contexts; it is not a suite count. Review decision is `CHANGES_REQUESTED` and merge state `BLOCKED`.

## CI checkout distinction

The [main CI run](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214610) reports PR head `7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b` in run metadata. Its three Build job checkout logs show **synthetic merge `d5b5e5b5c678570ed123084405602baafe78e986`** (`refs/pull/2960/merge`), merging that head into base `a3456b1754b5d139fb03c09a628026d1bab3a54f`. The live local checks use the detached PR head; these are distinct provenance claims.

## Results

| Workflow/job | Result | Evidence |
| --- | --- | --- |
| gitleaks | success | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214610/job/134069986795) |
| Shell API contract | success | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214610/job/134074736212) |
| Build / macOS (ARM64) | success; Build=success, Test=success | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214610/job/134074736501) |
| Build / Windows Server 2022 | success; Build=success, Test=success | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214610/job/134074736540) |
| Build / Ubuntu 22.04 | success; Build=success, Test=success | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214610/job/134074736572) |
| Build / ${{ matrix.label }} | skipped | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214610/job/134074738687) |
| CI OK | success | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214610/job/134094199747) |
| Docs site build | success | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214601/job/134069983753) |
| check-externals (PR) | success | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214695/job/134069986630) |
| check-externals (nightly) | skipped | [job](https://github.com/rocketride-org/rocketride-server/actions/runs/44092214695/job/134069989395) |

The three Build job logs contain the 468-shell-test summary and sampled named cases for policy P1/P26, the exact blob-iframe sequence, and the production real-listener refusal. No raw logs were saved or published by this audit.

## Exact-head security regression inventory

| Invariant | Source evidence |
| --- | --- |
| Production gate: URL cannot enable hooks | [packages/shell/src/util/devMode.test.ts:132](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.test.ts#L132) |
| Production gate: URL/storage/boot-config combinations | [packages/shell/src/util/devMode.test.ts:163](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.test.ts#L163) |
| Real listener: production installs no hooks and answers nobody | [packages/shell/src/util/devMode.listener.test.ts:391](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.listener.test.ts#L391) |
| Policy P1–P26: relation/origin matrix; includes same-origin loopback web builder positives | [packages/shell/src/util/devMode.test.ts:463](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.test.ts#L463) |
| Null opener and unrelated source refusal | [packages/shell/src/util/devMode.test.ts:399](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.test.ts#L399) |
| Nested window.top is not parent | [packages/shell/src/util/devMode.test.ts:427](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.test.ts#L427) |
| Handler remote entry validation | [packages/shell/src/util/devMode.test.ts:265](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.test.ts#L265) |
| Canonical loopback-only HTTP(S), no credential URLs | [packages/shell/src/util/devMode.test.ts:580](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.test.ts#L580) |
| Loader choke point rejects disallowed remote | [packages/shell/src/util/appLoader.test.ts:227](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/appLoader.test.ts#L227) |
| Loader registers vetted canonical entry | [packages/shell/src/util/appLoader.test.ts:250](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/appLoader.test.ts#L250) |
| Real listener: VS Code auth, remote registration and console sequence | [packages/shell/src/util/devMode.listener.test.ts:290](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.listener.test.ts#L290) |
| Real listener: blob iframe auth grant/revoke and forwarding sequence | [packages/shell/src/util/devMode.listener.test.ts:319](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.listener.test.ts#L319) |
| Real listener: same-origin opener auth and foreign-origin refusal | [packages/shell/src/util/devMode.listener.test.ts:345](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.listener.test.ts#L345) |
| Console forwarding to verified origin only | [packages/shell/src/util/devMode.listener.test.ts:259](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/util/devMode.listener.test.ts#L259) |
| Production token fragment ignored and stripped | [packages/shell/src/connection/connection.test.ts:2506](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/connection/connection.test.ts#L2506) |
| Framed auth uses embedder; fragment remains embedder-owned | [packages/shell/src/connection/connection.test.ts:2526](https://github.com/rocketride-org/rocketride-server/blob/7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b/packages/shell/src/connection/connection.test.ts#L2526) |

The current local verification records 468 shell tests passed, 0 failed. This read-only supplemental audit did not rerun them. Unit/listener coverage supplements the live host evidence; it does not replace it.

Skipped jobs are not passes. Four current skipped contexts: container scan, inactive build matrix placeholder, Helm lint/kubeconform, and check-externals nightly. No merge or deployment was performed.
