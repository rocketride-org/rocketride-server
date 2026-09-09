// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Client Docs Module
 *
 * Owns the agent documentation bundle: `client-docs:agent` packs
 * docs/agents/ROCKETRIDE_*.md and docs/stubs/* into docs.zip and stages
 * it into static/clients/docs beside the engine, where GET /client/docs
 * serves it. Every client build (client-typescript, client-python,
 * client-mcp) and the vscode build list the task as a step, so the
 * served bundle always matches the tree the clients were built from —
 * never a copy frozen into a client package.
 *
 * Distinct from the `docs` module (packages/docs), which owns the
 * documentation SITE; this module owns the agent-facing bundle.
 */
const path = require('path');
const { glob } = require('glob');
const { exists, mkdir, rm, setState, getState, copyFile, removeDirs, syncDir, formatSyncStats, writeJson, createArchive, contentHash, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT } = require('../../scripts/lib');

// Sources: the agent docs and the per-agent stubs
const AGENT_DOCS_DIR = path.join(PROJECT_ROOT, 'docs', 'agents');
const AGENT_STUBS_DIR = path.join(PROJECT_ROOT, 'docs', 'stubs');
// Staging + output
const AGENT_BUILD_DIR = path.join(BUILD_ROOT, 'agent-docs');
const AGENT_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'clients', 'docs');
// Content-hash gate so the staged zip stays byte-stable between edits
const AGENT_BUNDLE_HASH_KEY = 'clientDocs.agentBundle';

/**
 * client-docs:agent — stage the agent documentation bundle (docs.zip).
 *
 * Contents: docs/agents/ROCKETRIDE_*.md at the bundle root, docs/stubs/*
 * under stubs/, plus manifest.json carrying the content hash consumers
 * (the CLI's `rocketride init`, the VS Code extension) use as their
 * change stamp when installing into a workspace's .rocketride/docs.
 */
function makeAgentBundleAction() {
	return {
		run: async (ctx, task) => {
			const stageDir = path.join(AGENT_BUILD_DIR, 'stage');
			const outDir = path.join(AGENT_BUILD_DIR, 'out');
			const zipPath = path.join(outDir, 'docs.zip');

			// step: restage from scratch so retired docs cannot fossilize
			await removeDirs([stageDir]);
			await mkdir(path.join(stageDir, 'stubs'));
			const docFiles = (await glob('*.md', { cwd: AGENT_DOCS_DIR, absolute: true })).sort();
			for (const file of docFiles) {
				await copyFile(file, path.join(stageDir, path.basename(file)));
			}
			const stubFiles = (await glob('*', { cwd: AGENT_STUBS_DIR, absolute: true, nodir: true })).sort();
			for (const file of stubFiles) {
				await copyFile(file, path.join(stageDir, 'stubs', path.basename(file)));
			}

			// step: hash the staged content — the consumers' change stamp
			const hash = await contentHash(stageDir);
			const files = [...docFiles.map((f) => path.basename(f)), ...stubFiles.map((f) => `stubs/${path.basename(f)}`)];
			await writeJson(path.join(stageDir, 'manifest.json'), { hash, files });

			// step: repack only when content changed — dist zip stays byte-stable
			const savedHash = await getState(AGENT_BUNDLE_HASH_KEY);
			if (hash !== savedHash || !(await exists(zipPath))) {
				await mkdir(outDir);
				await createArchive(zipPath, stageDir, [...files.filter((f) => !f.startsWith('stubs/')), 'stubs', 'manifest.json']);
				await setState(AGENT_BUNDLE_HASH_KEY, hash);
			}

			// step: heal the served copy (also on cache-skip) and record it for
			// server:package so the bundle rides the release archive
			const stats = await syncDir(outDir, AGENT_STATIC_DIR, { pattern: '*.zip', package: true });
			task.output = `Agent docs bundle staged (${files.length} files) ${formatSyncStats(stats)}`;
		}
	};
}

/** client-docs:clean — remove the staging tree and the served bundle. */
function makeCleanAction() {
	return {
		description: 'Clean client docs bundle',
		run: async (ctx, task) => {
			await rm(AGENT_BUILD_DIR);
			await rm(AGENT_STATIC_DIR);
			await setState(AGENT_BUNDLE_HASH_KEY, null);
			task.output = 'Cleaned agent docs bundle';
		}
	};
}

module.exports = {
	name: 'client-docs',
	description: 'Agent documentation bundle (served at /client/docs)',

	actions: [
		// client-docs:agent is description-less on purpose — it rides its
		// dependents (every client build + vscode), not the bare
		// `builder build` aggregate.
		{ name: 'client-docs:agent', action: makeAgentBundleAction },
		{ name: 'client-docs:clean', action: makeCleanAction }
	]
};
