import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import llms from '../../scripts/lib/llms.js';
import spine from '../../scripts/lib/spine.js';

const { buildIndex, SITE_URL } = llms;
const { allDocIds } = spine;

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
			{ id: 'concepts/pipelines', route: '/concepts/pipelines', title: 'Pipelines', mdSibling: '/concepts/pipelines.md', description: 'A pipeline is a directed graph of nodes.' },
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
		assert.match(index, /## Get Started/);
		assert.match(index, /## Concepts/);
		// Links are absolute (the llms.txt format specifies URLs) and carry the
		// manifest description when the page has one.
		assert.match(index, /\[Pipelines\]\(https:\/\/docs\.rocketride\.org\/concepts\/pipelines\.md\): A pipeline is a directed graph of nodes\./);
		// An entry without a description degrades to a bare link, no trailing colon.
		assert.match(index, /\[Quickstart\]\(https:\/\/docs\.rocketride\.org\/quickstart\.md\)\n/);
		// Get Started section precedes Concepts (spine order)
		assert.ok(index.indexOf('## Get Started') < index.indexOf('## Concepts'));
	});

	it('writes llms-full.txt with the generated node catalog inlined', async () => {
		const full = await readFile(path.join(staticDir, 'llms-full.txt'), 'utf8');
		assert.match(full, /^# RocketRide Documentation/m);
		assert.match(full, /Route: \/nodes/);
	});

	describe('published .md copies', () => {
		let root;
		let content;
		let stat;
		let twinPath;

		before(async () => {
			root = await mkdtemp(path.join(os.tmpdir(), 'rr-llms-twin-'));
			content = path.join(root, 'content');
			stat = path.join(root, 'static');
			await mkdir(content, { recursive: true });
			await mkdir(stat, { recursive: true });
			const raw = '---\ntitle: Guide\n---\n\nimport Tabs from "@theme/Tabs";\n\n# Guide\n\nBody text.\n';
			const source = path.join(content, 'guide.mdx');
			await writeFile(source, raw);
			await writeFile(path.join(content, '.manifest.json'), JSON.stringify([{ id: 'guide', route: '/guide', title: 'Guide', mdSibling: '/guide.md', source }]));
			twinPath = path.join(stat, 'guide.md');
			await writeFile(twinPath, raw);
			await buildIndex({ contentDir: content, staticDir: stat });
		});

		after(async () => {
			await rm(root, { recursive: true, force: true });
		});

		it('rewrites a raw copy to start with the index line and drop front matter', async () => {
			const twin = await readFile(twinPath, 'utf8');
			assert.ok(twin.startsWith(`> Documentation index for agents: ${SITE_URL}/llms.txt\n`));
			assert.doesNotMatch(twin, /^---$/m);
			assert.doesNotMatch(twin, /title: Guide/);
			assert.match(twin, /Body text\./);
		});

		it('drops import lines from entries whose source is .mdx', async () => {
			const twin = await readFile(twinPath, 'utf8');
			assert.doesNotMatch(twin, /^import /m);
		});

		it('does not add the index line twice on a second run', async () => {
			const first = await readFile(twinPath, 'utf8');
			await buildIndex({ contentDir: content, staticDir: stat });
			const second = await readFile(twinPath, 'utf8');
			assert.equal(second, first);
			assert.equal(second.split('> Documentation index for agents').length - 1, 1);
		});

		it('cleans the page section inside llms-full.txt', async () => {
			const full = await readFile(path.join(stat, 'llms-full.txt'), 'utf8');
			assert.match(full, /Route: \/guide/);
			assert.match(full, /Body text\./);
			assert.doesNotMatch(full, /^import /m);
			assert.doesNotMatch(full, /title: Guide/);
		});
	});
});

describe('buildIndex Start here section', () => {
	const agentEntry = { id: 'quickstart/coding-agents', route: '/quickstart/coding-agents', title: 'Use RocketRide from a coding agent', mdSibling: '/quickstart/coding-agents.md', description: 'x' };
	const others = [
		{ id: 'quickstart', route: '/quickstart', title: 'Quickstart', mdSibling: '/quickstart.md' },
		{ id: 'concepts/pipelines', route: '/concepts/pipelines', title: 'Pipelines', mdSibling: '/concepts/pipelines.md' },
	];

	async function indexFor(manifest) {
		const root = await mkdtemp(path.join(os.tmpdir(), 'rr-llms-start-'));
		try {
			const contentDir = path.join(root, 'content');
			const staticDir = path.join(root, 'static');
			await mkdir(contentDir, { recursive: true });
			await mkdir(staticDir, { recursive: true });
			await writeFile(path.join(contentDir, '.manifest.json'), JSON.stringify(manifest));
			await buildIndex({ contentDir, staticDir });
			return await readFile(path.join(staticDir, 'llms.txt'), 'utf8');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	it('puts Start here before Get Started and lists the agent page exactly once', async () => {
		const index = await indexFor([...others, agentEntry]);
		assert.ok(index.includes('## Start here'));
		assert.ok(index.indexOf('## Start here') < index.indexOf('## Get Started'));
		assert.equal(index.split('/quickstart/coding-agents.md').length - 1, 1);
	});

	it('omits the Start here heading when the manifest has no agent entry', async () => {
		const index = await indexFor(others);
		assert.ok(!index.includes('## Start here'));
	});

	it('finds the agent start page among the spine doc ids', async () => {
		// Built from the real spine: if the start id in llms.js and the spine id drift apart, the section disappears.
		const manifest = allDocIds().map((id) => ({ id, route: `/${id}`, title: id, mdSibling: `/${id}.md` }));
		const index = await indexFor(manifest);
		assert.ok(index.includes('## Start here'), 'no spine id matches the start id in llms.js');
	});
});
