# PR 2960 live acceptance — 2026-11-19

Tested commit: `7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b`.
PR: https://github.com/rocketride-org/rocketride-server/pull/2960

## Observed results

- **VS Code F5 Extension Development Host: PASS.** Launched the fresh checkout's `build/vscode` through a temporary extensionHost launch configuration. Opened the canonical scaffold's `rr2960.rrapp` and Design preview. Actual `vscode-webview://` parent; local remote served at `http://localhost:3957`. The Console recorded `embedder session received — continuing boot`, a local-override registration before the URL-convention self-registration, the unique fixture sentinel, and successful protected engine reads. The later preview screenshot displays `EDIT_B`, authenticated developer identity, four completed reads and dev hooks present. The earlier Console screenshot displays `EDIT_A`; the later fixture edit was also observed in forwarded Console rows.
- **Real web App Builder iframe: PASS.** Opened Rocket Builder → Apps → PR 2960 Live Check → Design against the isolated engine. Actual same-origin blob iframe renders `EDIT_B`, developer identity, dev hooks present and successful protected read (four completed reads after the explicit recheck).
- **Real web App Builder debug tab: UI smoke PASS; screenshot pending.** Clicked the actual `linked in browser` action. The newly opened blob tab's initial accessibility snapshot showed `EDIT_B`, authenticated developer identity, three completed protected reads, `Framed: false`, opener present and same origin, and dev hooks present. A subsequent handshake-button click and screenshot were rejected by the browser automation URL policy (only http/https allowed). No workaround was used. No direct auth-reply observation or debug screenshot is claimed; the debug tab remains open for the user to capture.

## Runtime and controls

Isolated real native engine at `http://localhost:5565`, fresh filesystem store and disposable local credentials. The official Mac arm64 engine-cache source hash matches this checkout: `6083bbc82493e229211d0cd9e23fe186be91d619c2ab70447522b8a95114121f`. Exact-head Python, SDK, shell and Rocket Builder assets were staged; served shell index hash matches the fresh build. See `artifact-provenance.json` and `environment.json`.

The fixture uses the public SDK `fsReadString` to read a private marker file from the engine. The exact instance rejected an incorrect credential with `AuthenticationException` (sample-auth-control.log). The sample app was created through the canonical scaffold and seeded through the authenticated SDK. Its diagnostics use the rendered DOM's `ownerDocument.defaultView`, because web linked code may execute in the builder's realm.

468 shell tests passed; shell production/dev flavors, VS Code extension and Rocket Builder builds completed. Full `server:build` was stopped before unrelated native-node builds; targeted runtime dependency/sync/staging completed. Standard build-generated SDK_VERSION synchronization (1.5.0 → the manifest's 1.6.0) is recorded in provenance; no hand-edited product source or PR commit change.

Node 24.13.1 was used after the default Node 26 native dependency build failed. Credentials, headers, storage contents, raw runtime logs and local .env files are excluded from publication. Screenshots were visually checked. The additional screenshot/direct auth-reply limitations above remain open; no Firefox/Safari or production deployment result is claimed.

## Supplemental production and sender controls

Additional exact-head verification on 19 November 2026: five real-browser
controls passed, and the focused policy/listener suites passed 81/81 under
both production and development environments. See
[supplemental-summary.md](supplemental-summary.md),
[supplemental-controls.jpg](supplemental-controls.jpg), and
[supplemental-sanitized.zip](supplemental-sanitized.zip). The CI audit also
records successful build/test jobs and distinguishes the synthetic merge
checkout from the detached head used locally.

The actual App Builder debug screenshot/direct reply observation remains
pending; these independent HTTP controls do not replace that capture.
