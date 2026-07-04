import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import llms from '../../scripts/lib/llms.js';

const { buildIndex } = llms;

describe('buildIndex', () => {
	let contentDir;
	let staticDir;

	before(async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'rr-llms-'));
		contentDir = path.join(root, 'content');
		staticDir = path.join(root, 'static');
		await mkdir(contentDir, { recursive: true });
		await mkdir(staticDir, { recursive: true });

		const manifest = [
			{ id: 'quickstart', route: '/quickstart', title: 'Quickstart', mdSibling: '/quickstart.md' },
			{ id: 'concepts/pipelines', route: '/concepts/pipelines', title: 'Pipelines', mdSibling: '/concepts/pipelines.md' },
			{ id: 'nodes/webhook', route: '/nodes/webhook', title: 'webhook', mdSibling: '/nodes/webhook.md', node: 'webhook' },
		];
		await writeFile(path.join(contentDir, '.manifest.json'), JSON.stringify(manifest));

		await buildIndex({ contentDir, staticDir });
	});

	after(async () => {
		await rm(path.dirname(contentDir), { recursive: true, force: true });
	});

	it('writes the node catalog landing page listing node entries', async () => {
		const catalog = await readFile(path.join(contentDir, 'nodes', 'index.md'), 'utf8');
		assert.match(catalog, /slug: \/nodes/);
		assert.match(catalog, /\[webhook\]\(\/nodes\/webhook\)/);
	});

	it('writes llms.txt grouping pages under their spine sections', async () => {
		const index = await readFile(path.join(staticDir, 'llms.txt'), 'utf8');
		assert.match(index, /^# RocketRide Documentation/m);
		assert.match(index, /## Quickstart/);
		assert.match(index, /## Concepts/);
		assert.match(index, /\[Pipelines\]\(\/concepts\/pipelines\.md\)/);
		// Quickstart section precedes Concepts (spine order)
		assert.ok(index.indexOf('## Quickstart') < index.indexOf('## Concepts'));
	});

	it('writes llms-full.txt with the generated node catalog inlined', async () => {
		const full = await readFile(path.join(staticDir, 'llms-full.txt'), 'utf8');
		assert.match(full, /^# RocketRide Documentation/m);
		assert.match(full, /Route: \/nodes/);
	});
});
