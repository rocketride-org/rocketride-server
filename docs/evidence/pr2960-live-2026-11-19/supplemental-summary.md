# Supplemental verification — PR 2960

Tested detached head: `7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b`.

All five browser controls passed on 19 November 2026:

| Case | Observed result |
| --- | --- |
| Production bundle, trusted same-origin parent, forged dev flags | Actual prod entries booted; hooks absent, observed token baseline unchanged, no registration, zero remote requests, no console forwarding. |
| Production bundle, cross-origin opener | Same inert behavior; refused top-level fragment removed. |
| Dev bundle, cross-origin parent | Hooks loaded; two untrusted-sender rejections, readable token baseline unchanged, no registration/requests/forwarding. |
| Dev bundle, cross-origin opener | Same sender rejection behavior; no token fragment was supplied for this sender test. |
| Dev bundle, same-origin parent positive | Accepted registration and forwarded the console sentinel. Anonymous fixture does not claim remote rendering or nonempty auth adoption. |

Each case required actual selected entry script loads, shell root rendering,
bootstrap portal initialization and no asset/bootstrap error. The opposite
flavor was not loaded. Four served entry files were independently hashed and
matched the build metadata. No flavor-picker script ran in these controls.

Focused exact-head policy/listener tests passed 81/81 with NODE_ENV=production
and 81/81 with NODE_ENV=development. See the two policy logs.

CI rollup at the recorded audit time was 29 successful contexts, 4 skipped,
no failures. The main three-OS Build/Test jobs passed on synthetic merge
`d5b5e5b5c678570ed123084405602baafe78e986`, merging the PR head into base
`a3456b1754b5d139fb03c09a628026d1bab3a54f`. This is distinct from the detached
head used for the local browser runs. See supplemental-ci.md for direct job
links, skipped context details, and exact-head security-test anchors.

The first harness expectation failures and fresh-window opener retry are
documented in supplemental-harness-notes.md; no product source was patched.

Reproduce with the original isolated engine serving this head's freshly built
assets, Node 24, and free loopback ports 5586/5587:

```sh
SUPPLEMENTAL_WORKTREE=/path/to/checkout node supplemental-server.mjs
```

Open http://localhost:5587/, click Run framed controls, then both opener
buttons. Use fresh opener windows. Timeouts/load failures remain failures or
inconclusive outcomes, never PASS. These HTTP fixtures are independent
security controls; they do not replace the actual host checks.

The real App Builder blob debug screenshot and direct auth-reply observation
remain pending because the browser automation URL policy forbids them. No
workaround was used. No merge or deployment was performed.
