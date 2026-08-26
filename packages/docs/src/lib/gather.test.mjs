import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pageDescription, stampLastUpdate, gather, assertNoUnexpectedPlaceholders, EXPECTED_PLACEHOLDERS } = require('../../scripts/lib/gather.js');

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

// The placeholder gate is the guardrail that makes doc moves safe: a doc id is
// the public URL, so a spine id and a file path drifting apart silently
// publishes a "coming soon" page instead of failing.
describe('assertNoUnexpectedPlaceholders', () => {
	const page = (id, extra = {}) => ({ id, route: `/${id}`, title: id, ...extra });

	it('throws for an unexpected placeholder, naming the id and the likely cause', () => {
		const manifest = [page('product/quickstart'), page('product/operate/cloud', { placeholder: true })];
		assert.throws(
			() => assertNoUnexpectedPlaceholders(manifest),
			(err) => {
				assert.match(err.message, /product\/operate\/cloud/);
				assert.match(err.message, /spine/i);
				assert.doesNotMatch(err.message, /quickstart/);
				return true;
			}
		);
	});

	it('names every offender, not just the first', () => {
		const manifest = [page('a/one', { placeholder: true }), page('b/two', { placeholder: true })];
		assert.throws(() => assertNoUnexpectedPlaceholders(manifest), /a\/one[\s\S]*b\/two/);
	});

	it('passes an allowlisted id so intentional stubs need no wholesale opt-out', () => {
		const manifest = [page('product/operate/cloud', { placeholder: true })];
		assert.doesNotThrow(() => assertNoUnexpectedPlaceholders(manifest, ['product/operate/cloud']));
	});

	// Emitted only when the node corpus produced no pages at all (docs-only
	// checkout), which the "Staged N nodes" count already reports — not a desync.
	it('tolerates the structural nodes/example placeholder', () => {
		assert.doesNotThrow(() => assertNoUnexpectedPlaceholders([page('nodes/example', { placeholder: true, node: 'example' })]));
	});

	it('passes a manifest with no placeholder at all', () => {
		assert.doesNotThrow(() => assertNoUnexpectedPlaceholders([page('index'), page('nodes/llm_anthropic')]));
	});

	// Seeded empty deliberately: today's build stages zero placeholders. A
	// growing allowlist is the failure mode this gate exists to prevent.
	it('allowlists only the IA-restructure content-pass stubs', () => {
		assert.deepEqual(EXPECTED_PLACEHOLDERS, ['guides/observability', 'operate/self-hosting/docker', 'operate/self-hosting/kubernetes', 'support/get-help', 'support/contributing', 'support/release-notes']);
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
		await mkdir(path.join(projectRoot, 'docs/public/typescript'), { recursive: true });
		await writeFile(path.join(projectRoot, 'docs/public/typescript/index.md'), '# TypeScript SDK\n\nThe TypeScript client library.\n');
		await writeFile(path.join(projectRoot, 'docs/public/typescript/README.md'), '# Package README\n\nExport source for docs:export, never a site page.\n');
		manifest = await gather({ projectRoot, contentStaticDir: path.join(root, 'no-such-static-dir'), contentDir, staticDir });
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('stages a page for the clients/typescript mount sourced from index.md', async () => {
		const staged = await readFile(path.join(contentDir, 'clients', 'typescript.md'), 'utf8');
		assert.match(staged, /The TypeScript client library\./);
		const entry = manifest.find((m) => m.id === 'clients/typescript');
		assert.ok(entry, 'manifest entry for clients/typescript');
		assert.equal(entry.route, '/clients/typescript');
	});

	it('stages no page or route for README.md', () => {
		assert.equal(existsSync(path.join(contentDir, 'clients', 'typescript', 'README.md')), false);
		const entry = manifest.find((m) => m.source && m.source.endsWith('README.md'));
		assert.equal(entry, undefined, 'no manifest entry sourced from README.md');
	});
});
