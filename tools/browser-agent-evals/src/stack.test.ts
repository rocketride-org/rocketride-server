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
// STACK TESTS: each slot's ports and folders, and the shell config it runs
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT } from './catalog';
import { MAX_SLOTS, shellWrapper, slotPlan } from './stack';

interface ProxyRule {
	target: string;
	ws?: boolean;
}

interface LoadedConfig {
	server: { port: number; proxy: Record<string, ProxyRule> };
	output: { distPath: { root: string } };
}

/** Writes a generated shell config to a temp folder and loads it as rsbuild would, through its default export. */
async function loadWrapper(text: string): Promise<LoadedConfig> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-wrapper-'));
	try {
		const file = path.join(dir, 'wrapper.mts');
		fs.writeFileSync(file, text);
		return ((await import(file)) as { default: LoadedConfig }).default;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('slot 0 keeps the stack it always had, and no two slots share a port, a config file or a folder', () => {
	assert.deepEqual(slotPlan(0), { slot: 0, enginePort: 5565, taskBasePort: 20000, uiPort: 3010, shellPort: 3000, wrapper: '.rocketride/browser-agent-evals.rsbuild.config.mts', dir: 'stack' });
	assert.deepEqual([slotPlan(1).enginePort, slotPlan(1).shellPort, slotPlan(1).uiPort, slotPlan(1).taskBasePort], [5610, 3110, 3111, 30000]);
	const plans = Array.from({ length: MAX_SLOTS }, (_, k) => slotPlan(k));
	const ports = plans.flatMap((p) => [p.enginePort, p.uiPort, p.shellPort]);
	assert.equal(new Set(ports).size, ports.length);
	const windows = plans.map((p) => [p.taskBasePort, p.taskBasePort + 9999]).sort((a, b) => a[0] - b[0]);
	for (let k = 1; k < windows.length; k++) assert.ok(windows[k][0] > windows[k - 1][1], `task windows ${windows[k - 1]} and ${windows[k]} overlap`);
	assert.ok(windows.at(-1)![1] <= 65535, 'the last task window fits below 65536');
	assert.ok(windows.every(([lo]) => !ports.some((p) => p >= lo && p <= lo + 9999)), 'no stack port sits in a task window');
	assert.equal(new Set(plans.map((p) => p.wrapper)).size, MAX_SLOTS);
	assert.equal(new Set(plans.map((p) => p.dir)).size, MAX_SLOTS);
});

test("a slot's shell sends every path the shell proxies to that slot's engine, and the dev remote to its rocket-ui", async () => {
	const shellConfig = path.join(REPO_ROOT, 'packages', 'shell', 'rsbuild.config.mts');
	const real = (await import(shellConfig)) as { default: (env: { command: string }) => { server: { proxy: Record<string, ProxyRule> } } };
	const routes = real.default({ command: 'dev' }).server.proxy;
	assert.ok(Object.keys(routes).length >= 12, 'the shell proxies the engine paths');

	const plan = slotPlan(2);
	const config = await loadWrapper(shellWrapper(plan, '/tmp/slot-2-shell-dist'));
	const [first, ...rest] = Object.entries(config.server.proxy);
	assert.deepEqual(first, ['/apps/rocketride.pipeBuilder/dev', { target: `http://127.0.0.1:${plan.uiPort}` }]);
	assert.deepEqual(Object.fromEntries(rest), Object.fromEntries(Object.entries(routes).map(([route, rule]) => [route, { ...rule, target: `http://127.0.0.1:${plan.enginePort}` }])));
	assert.equal(config.server.port, plan.shellPort);
	assert.equal(config.output.distPath.root, '/tmp/slot-2-shell-dist');
});

test('a shell proxy rule that goes anywhere but the engine stops the slot from starting', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-shell-'));
	try {
		const base = path.join(dir, 'rsbuild.config.mts');
		fs.writeFileSync(base, "export default () => ({ server: { proxy: { '/api': { target: 'http://localhost:5565', ws: true }, '/metrics': { target: 'http://localhost:9090' } } } });\n");
		await assert.rejects(loadWrapper(shellWrapper(slotPlan(1), path.join(dir, 'out'), base)), /proxies \/metrics to http:\/\/localhost:9090, not the engine on 5565/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
