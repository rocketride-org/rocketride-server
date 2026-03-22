# AI Agent Testing Plan for RocketRide

Based on Reddit March 2026 best practices: Claude Code + Playwright MCP for autonomous test-write-fix cycles.

## Testing Layers

### Layer 1: API Endpoint Tests (Playwright MCP — no UI needed)

Test all HTTP endpoints the engine and Lambda expose:

**OAuth Lambda (oauth2.rocketride.ai)**

- `GET /health` → 200 `{"status": "ok"}`
- `GET /google?baseURL=...` → 302 redirect to Google
- `GET /google` (no baseURL) → 400 `{"error": "invalid_redirect_url"}`
- `GET /microsoft?baseURL=...` → 302 redirect to Microsoft
- `GET /nonexistent` → 404 `{"error": "not_found"}`
- `POST /refresh` (no body) → 400 `{"error": "missing_refresh_token"}`

**VS Code Marketplace**

- Verify extension page loads
- Verify README is displayed
- Verify version matches latest release

### Layer 2: React Webview Tests (Vitest — offline)

**chat-ui components**

- Message: renders user/bot/system messages, handles markdown
- ChatInput: accepts text, triggers send on Enter
- ChatMessages: scrolls to bottom on new message
- ChatContainer: connects WebSocket, shows connection status
- MarkdownRenderer: renders code blocks, tables, links

**dropper-ui components**

- DropZone: drag-over/processing/disabled states, file input
- FileList: shows selected files with sizes
- UploadProgress: shows progress bar
- ResultsContent: renders JSON response

### Layer 3: Python Node Tests (pytest — offline)

**Smoke tests (already done: 445 tests)**

- Import validation
- Services.json parsing
- Lane validation
- Class type validation

**Functional tests (need mock engine)**

- Preprocessor nodes: chunk text correctly
- Prompt node: merges instructions with questions
- Response node: formats output correctly
- Question node: creates question objects

### Layer 4: TypeScript Client SDK Tests (Jest — offline)

- Client construction with various configs
- Event callback registration
- Pipeline config validation
- Question schema creation

### Layer 5: E2E Pipeline Tests (need running engine)

- Chat flow: connect → send question → receive answer
- Ingest flow: upload file → parse → chunk → response
- Search flow: query → embed → search → response

## AI Agent Workflow

For each layer, the agent should:

1. **Research** — Gemini CLI for latest Reddit patterns
2. **Explore** — Playwright MCP to browse running app (if applicable)
3. **Write** — Generate test files in the repo
4. **Run** — Execute tests and capture results
5. **Fix** — If tests reveal bugs, fix the source code
6. **Review** — Run CodeRabbit on changes

## Current Progress

- [x] Layer 3: Python smoke tests (445 tests)
- [x] Layer 2: chat-ui Message tests (5 tests)
- [x] Layer 2: dropper-ui DropZone tests (7 tests)
- [ ] Layer 1: OAuth API endpoint tests (via Playwright agent)
- [ ] Layer 2: More chat-ui component tests
- [ ] Layer 4: TS client SDK unit tests
- [ ] Layer 5: E2E pipeline tests
