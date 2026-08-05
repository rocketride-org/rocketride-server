import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pageDescription, stampLastUpdate, gather } = require('../../scripts/lib/gather.js');

describe('pageDescription', () => {
	it('prefers a front-matter description when the page declares one', () => {
		const md = '---\ntitle: Hi\ndescription: Declared up front.\n---\n\n# Hi\n\nProse instead.\n';
		assert.equal(pageDescription(md), 'Declared up front.');
	});

	// A block scalar's value is the indented run beneath it; the bare '>' or '|'
	// indicator must never become the description.
	it('reads a folded block-scalar description', () => {
		const md = '---\ntitle: T\ndescription: >\n  Folded across\n  two lines.\n---\n\n# T\n\nProse.\n';
		assert.equal(pageDescription(md), 'Folded across two lines.');
	});

	it('reads a literal block-scalar description', () => {
		const md = '---\ntitle: T\ndescription: |\n  Literal block.\n---\n\n# T\n\nProse.\n';
		assert.equal(pageDescription(md), 'Literal block.');
	});

	it('reads a chomped block-scalar description', () => {
		const md = '---\ntitle: T\ndescription: >-\n  Stripped fold.\n---\n\n# T\n\nProse.\n';
		assert.equal(pageDescription(md), 'Stripped fold.');
	});

	it('strips surrounding quotes from an inline description', () => {
		assert.equal(pageDescription('---\ntitle: T\ndescription: "Quoted."\n---\n\n# T\n\nProse.\n'), 'Quoted.');
	});

	it('falls back to the first prose sentence, skipping the heading', () => {
		const md = '---\ntitle: Hi\n---\n\n# Hi\n\nA pipeline is a graph. More after the stop.\n';
		assert.equal(pageDescription(md), 'A pipeline is a graph.');
	});

	it('skips MDX imports and JSX to reach the prose', () => {
		const md = "---\ntitle: Q\n---\n\nimport { Foo } from 'react-icons';\n\n<Foo />\n\n# Q\n\nPick the path that suits you.\n";
		assert.equal(pageDescription(md), 'Pick the path that suits you.');
	});

	it('strips inline links and emphasis from the extracted sentence', () => {
		const md = '# T\n\nSee the [engine](/concepts/engine) and **run** it.\n';
		assert.equal(pageDescription(md), 'See the engine and run it.');
	});

	it('returns an empty string when the page has no leading prose', () => {
		assert.equal(pageDescription('---\ntitle: T\n---\n\n# T\n\n```js\ncode();\n```\n'), '');
	});
});

describe('stampLastUpdate', () => {
	const D = '2026-07-16';

	it('merges into an existing front-matter block', () => {
		const out = stampLastUpdate('---\ntitle: Hi\n---\n\n# Body\n', D);
		assert.match(out, /^---\ntitle: Hi\nlast_update:\n {2}date: 2026-07-16\n---\n/);
	});

	it('creates a front-matter block when the page has none', () => {
		const out = stampLastUpdate('# Body\n', D);
		assert.match(out, /^---\nlast_update:\n {2}date: 2026-07-16\n---\n\n# Body\n$/);
	});

	// Regression: startsWith('---\n') was false on a CRLF checkout, so a SECOND
	// front-matter block was prepended and `title` fell out into the body.
	it('merges into CRLF front matter rather than prepending a second block', () => {
		const out = stampLastUpdate('---\r\ntitle: Hi\r\n---\r\n\r\n# Body\r\n', D);
		assert.equal((out.match(/^---\r?$/gm) || []).length, 2, 'exactly one front-matter block');
		assert.match(out, /title: Hi/);
		assert.match(out, /date: 2026-07-16/);
		// title must still be inside the front matter, not stranded in the body.
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(out)[1];
		assert.match(fm, /title: Hi/);
	});

	// The guard reads the front matter only: a `last_update:` line in the body
	// (a YAML code sample) must not cost the page its sitemap date.
	it('stamps a page whose body merely mentions last_update', () => {
		const md = '---\ntitle: T\n---\n\n# T\n\n```yaml\nlast_update:\n  date: 2020-01-01\n```\n';
		assert.match(stampLastUpdate(md, D), /date: 2026-07-16/);
	});

	it('is a no-op when the date is null or a date is already declared', () => {
		assert.equal(stampLastUpdate('# B\n', null), '# B\n');
		const already = '---\nlast_update:\n  date: 2020-01-01\n---\n\n# B\n';
		assert.equal(stampLastUpdate(already, D), already);
	});

	it('does not treat a body horizontal rule as the front-matter close', () => {
		const out = stampLastUpdate('---\ntitle: Hi\n---\n\n# Body\n\n---\n\nmore\n', D);
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(out)[1];
		assert.match(fm, /last_update/);
		assert.match(fm, /title: Hi/);
	});
});

// gather() itself is exercised end-to-end (not stubbed) against a temp
// project, mirroring llms.test.mjs's temp-project pattern. discoverContributors()
// reads the real (in-process) module registry, but docs:test runs this file via
// a fresh `node --test` subprocess that never calls registry.discover(), so the
// registry is empty here and only the DOCS_ROOT_MOUNTS contributors we're adding
// are exercised — the test stays isolated from the real repo's package mounts.
describe('gather — top-level docs/ root mounts', () => {
	let root;
	let projectRoot;
	let contentDir;
	let manifest;

	before(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rr-gather-'));
		projectRoot = path.join(root, 'project');
		contentDir = path.join(root, 'content');
		const staticDir = path.join(root, 'static');
		await mkdir(path.join(projectRoot, 'docs/clients/typescript'), { recursive: true });
		await writeFile(path.join(projectRoot, 'docs/clients/typescript/index.md'), '# TypeScript SDK\n\nThe TypeScript client library.\n');
		await writeFile(path.join(projectRoot, 'docs/clients/typescript/readme.md'), '# Package README\n\nExport source for docs:export, never a site page.\n');
		manifest = await gather({ projectRoot, contentStaticDir: path.join(root, 'no-such-static-dir'), contentDir, staticDir });
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('stages a page for the develop/typescript mount sourced from index.md', async () => {
		const staged = await readFile(path.join(contentDir, 'develop', 'typescript.md'), 'utf8');
		assert.match(staged, /The TypeScript client library\./);
		const entry = manifest.find((m) => m.id === 'develop/typescript');
		assert.ok(entry, 'manifest entry for develop/typescript');
		assert.equal(entry.route, '/develop/typescript');
	});

	it('stages no page or route for readme.md', () => {
		assert.equal(existsSync(path.join(contentDir, 'develop', 'typescript', 'readme.md')), false);
		const entry = manifest.find((m) => m.source && m.source.endsWith('readme.md'));
		assert.equal(entry, undefined, 'no manifest entry sourced from readme.md');
	});
});
