// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// PLAYWRIGHT CONFIG: separate-origin app isolation (#1022 PR2c)
// =============================================================================
// Chromium only. One worker (each worker owns one engine server, started by the
// `server` fixture in support/harness.ts), no retries: an exploit that
// succeeds once is a failure, not a flake.
//
// What the suite needs on the machine:
//   - the built shell and guest under dist/server/static (`./builder shell:build`
//     or `shell:bundle shell:copy shell:guest-build shell:guest-copy`);
//   - the fixture apps: `pnpm --filter shell e2e:fixtures`;
//   - a Python with the engine's web dependencies (E2E_PYTHON, default python3):
//     fastapi, uvicorn, cryptography, aiofiles, websockets, python-dotenv, pydantic;
//   - Chromium: `pnpm exec playwright install chromium`.
//
// E2E_MODE picks the engine's isolation mode for the run: `enforce` (default),
// `optin`, or `off` (the red base: the fixture runs in the shell realm).
// E2E_SRC_ROOT and E2E_ENGINE_DIR point the server at another checkout and its
// built dist/server (the PR1 head, for the red base of plan section 5.4).
// =============================================================================

import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './specs',
	outputDir: './.results/artifacts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: [['list'], ['json', { outputFile: './.results/report.json' }]],
	use: {
		browserName: 'chromium',
		launchOptions: { args: ['--host-resolver-rules=MAP *.apps.localhost 127.0.0.1'] },
	},
});
