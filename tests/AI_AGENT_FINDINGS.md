# AI Agent Testing Findings — March 22, 2026

9 autonomous AI agents tested RocketRide in parallel using Playwright MCP + source code auditing.

## Critical Bugs

| #   | Severity | Category  | Location                         | Description                                                  |
| --- | -------- | --------- | -------------------------------- | ------------------------------------------------------------ |
| 1   | CRITICAL | Release   | VS Code Marketplace              | README empty — "No overview has been entered by publisher"   |
| 2   | CRITICAL | Release   | Ubuntu CI                        | Missing `glob` dep breaks vscode build — no vsix produced    |
| 3   | HIGH     | Security  | chat-ui MarkdownRenderer.tsx:28  | `rehypeRaw` enables raw HTML/XSS from pipeline responses     |
| 4   | HIGH     | Security  | vscode PageStatusProvider.ts:627 | `openLink()` webview: no CSP, inline script, unsanitized URL |
| 5   | HIGH     | Stability | Both React apps                  | No error boundaries — render crash kills entire app          |

## Security Audit Findings (Python + TypeScript)

| #   | Severity | Category      | Location                   | Description                                                         |
| --- | -------- | ------------- | -------------------------- | ------------------------------------------------------------------- |
| S1  | CRITICAL | Code Exec     | ai/common/sandbox.py:284   | Auto `pip install` of agent-requested packages — typosquatting risk |
| S2  | HIGH     | SQL Injection | vectordb_postgres.py:53-79 | String formatting in SQL queries instead of parameterized           |
| S3  | MEDIUM   | Dead Conn     | TransportWebSocket.ts:123  | Browser clients have no heartbeat — dead connections undetected     |
| S4  | MEDIUM   | Reconnect     | client.ts:456              | Reconnection after error doesn't reset transport state              |

## Medium Bugs

| #   | Severity | Category   | Location                        | Description                                               |
| --- | -------- | ---------- | ------------------------------- | --------------------------------------------------------- |
| 6   | MEDIUM   | Security   | Both apps                       | `postMessage('*')` wildcard, no `event.origin` validation |
| 7   | MEDIUM   | Stability  | chat-ui App.tsx:122             | `throw` in useEffect on missing auth crashes app          |
| 8   | MEDIUM   | Disposable | vscode extension.ts:208         | `pageDeploy` not in `context.subscriptions`               |
| 9   | MEDIUM   | Security   | chat-ui MarkdownRenderer.tsx:79 | iframe `sandbox="allow-scripts"` runs arbitrary JS        |

## Low Bugs (17 total)

Accessibility (8), memory leaks (3), disposable leaks (3), stability (2), activation delay (1).

Key a11y gaps: missing aria-labels on chat input/send button, no keyboard activation on DropZone, no ARIA tabs pattern, no `role="log"` on messages container.

## Broken Links

- `rocketride.ai/end-user-license-agreement/` — 404
- `rocketride.ai/master-saas-agreement/` — 404
- `rocketride.ai/privacy-policy` — 404
- `youtube.com/@RocketRideAI` — 404
- `docs.rocketride.ai/data-toolchain/source/google-drive` — 404
- GitHub links point to `rocketride-ai` (private) instead of `rocketride-org` (public)

## What's Working

- npm/PyPI packages: all READMEs displayed, verified
- Python tests: 870 collected, 770 passed, 0 failed
- docs.rocketride.ai: working, search works
- OAuth flow: all 4 endpoints verified
- GitHub repo: badges, releases, CI green on develop

## Fixes Applied in This PR

- [x] ErrorBoundary added to chat-ui and dropper-ui
- [x] `pageDeploy` added to `context.subscriptions`
- [x] WebSocket close mock updated in test setup
- [x] ErrorBoundary test (3 tests verifying crash recovery)
- [x] PR #330 created for missing `glob` dependency

## Remaining (for follow-up PRs)

- [ ] XSS via `rehypeRaw` — remove or add `rehype-sanitize`
- [ ] CSP in `openLink()` — add CSP meta, sanitize URL
- [ ] Broken docs/legal links — update URLs
- [ ] GitHub org links — change `rocketride-ai` to `rocketride-org`
- [ ] Accessibility fixes (8 issues)

## Mariner Visual Agent Findings (dropper-ui desktop 1280x720)

| #   | Bug                                                        | Severity | Category |
| --- | ---------------------------------------------------------- | -------- | -------- |
| M1  | Header separator line misplaced — renders above title text | MEDIUM   | Layout   |
| M2  | Dotted border broken at top-left corner of Connecting box  | MEDIUM   | Visual   |
| M3  | Connecting box not horizontally centered — shifted left    | MEDIUM   | Layout   |
| M4  | Trash icon present without context in connecting state     | MINOR    | UX       |
| M5  | No connection failure state or retry button                | HIGH     | UX       |
| M6  | Low contrast on secondary text (Connecting, Please wait)   | LOW      | A11y     |

## Mariner Visual Agent Findings (chat-ui desktop 1280x720)

| #   | Bug                                                             | Severity | Category  |
| --- | --------------------------------------------------------------- | -------- | --------- |
| C1  | Input placeholder contrast 3.31:1 — fails WCAG AA (needs 4.5:1) | HIGH     | A11y      |
| C2  | "Connecting..." as input placeholder is misleading              | HIGH     | UX        |
| C3  | Delete chat icon has no confirmation dialog                     | HIGH     | UX        |
| C4  | Empty chat area shows no welcome/guidance message               | HIGH     | UX        |
| C5  | Header elements vertically misaligned (right vs left)           | MEDIUM   | Layout    |
| C6  | "Connecting..." status text not left-aligned with title         | MEDIUM   | Alignment |
| C7  | No progress indicator during connection                         | MEDIUM   | UX        |
| C8  | "Ocean" dropdown meaning unclear without context                | MEDIUM   | UX        |
| C9  | No clear feedback on connection success                         | MEDIUM   | UX        |
| C10 | Send button too close to bottom edge                            | LOW      | Layout    |
| C11 | Send button vertically misaligned with placeholder              | LOW      | Alignment |
| C12 | Blue separator line too subtle                                  | LOW      | Visual    |
| C13 | Header "Connecting..." borderline contrast (5.45:1, AAA fail)   | LOW      | A11y      |
| C14 | Empty chat state uninviting                                     | LOW      | UX        |

## Agent Loop Audit Findings

| #   | Bug                                                          | Severity | Location                         |
| --- | ------------------------------------------------------------ | -------- | -------------------------------- |
| L1  | No timeout on CrewAI crew.kickoff() — blocks indefinitely    | HIGH     | agent_crewai/crewai.py:286       |
| L2  | No timeout on LangChain agent.invoke() — blocks indefinitely | HIGH     | agent_langchain/langchain.py:281 |
| L3  | No explicit max_iter on CrewAI Agent (relies on default 25)  | MEDIUM   | agent_crewai/crewai.py:198       |
| L4  | No recursion_limit on LangGraph agent                        | MEDIUM   | agent_langchain/langchain.py:279 |
| L5  | No depth guard against recursive agent-as-tool calls         | MEDIUM   | Both agent nodes                 |

## Python SDK Audit Findings

| #   | Bug                                                   | Severity | Location                           |
| --- | ----------------------------------------------------- | -------- | ---------------------------------- |
| P1  | API key logged in plaintext via debug protocol logger | HIGH     | execution.py:280, transport.py:112 |
| P2  | Auth credential logged in DAP auth request            | MEDIUM   | dap_client.py:322                  |
| P3  | requires-python >=3.8 but project needs 3.10+         | LOW      | pyproject.toml                     |
| P4  | Missing Python 3.13 classifier on PyPI                | LOW      | pyproject.toml                     |

## MCP Client Node Security Audit

| #    | Bug                                                                        | Severity | Location                                         |
| ---- | -------------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| MCP1 | CRITICAL: Arbitrary command execution via pipeline config commandLine      | CRITICAL | IGlobal.py:91, mcp_stdio_client.py:92            |
| MCP2 | No allowlist of permitted MCP server commands                              | CRITICAL | IGlobal.py:87-105                                |
| MCP3 | SSE/HTTP clients connect to any user-specified URL without validation      | HIGH     | mcp_sse_client.py, mcp_streamable_http_client.py |
| MCP4 | No MCP server authentication or identity verification                      | MEDIUM   | All transport clients                            |
| MCP5 | Tool arguments from LLM passed directly to MCP server without sanitization | MEDIUM   | IInstance.py                                     |

## Canvas Editor (shared-ui) Audit

| #   | Bug                                                                               | Severity | Location            |
| --- | --------------------------------------------------------------------------------- | -------- | ------------------- |
| CV1 | updateNodeInternals never called — floating edges when handles change dynamically | MEDIUM   | Node.tsx, Lanes.tsx |
| CV2 | ReactFlowProvider hierarchy                                                       | OK       | Correct wrapping    |
| CV3 | No hardcoded secrets in codebase                                                  | OK       | Grep verified       |
