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

/**
 * The pipeline store block and the per-pipe packer (plan §9): one .pipe,
 * its declared readme and icon, and the files the README references.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultStoreBlock, packPipe, PIPE_ICON_SVG, pipeStoreFiles, scaffoldPipe, scanReadmeReferences, validateStoreBlock } from '../src/app-pack/index';
import { PLACEHOLDER_ICON_SVG } from '../src/app-scaffold/index';

let ws: string;

beforeEach(() => {
	ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pipe-pack-'));
});

afterEach(() => {
	fs.rmSync(ws, { recursive: true, force: true });
});

/** Writes files under pipelines/<folder>/ and returns the folder. */
function folderOf(folder: string, files: Record<string, string | Buffer>): string {
	const abs = path.join(ws, 'pipelines', folder);
	fs.mkdirSync(abs, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(abs, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return abs;
}

/** A pipe JSON with the given store block (omitted when undefined). */
function pipeJson(store?: Record<string, unknown>): string {
	return JSON.stringify({ components: [], project_id: 'docBrain', name: 'Doc Brain', ...(store !== undefined ? { store } : {}) });
}

const STORE = { ...defaultStoreBlock(), tagline: 'Reads documents' };

describe('validateStoreBlock', () => {
	it('accepts the default block and names an unknown key, a bad mode, a bad path', () => {
		expect(validateStoreBlock(defaultStoreBlock())).toEqual(defaultStoreBlock());
		expect(() => validateStoreBlock({ publisher: 'acme' })).toThrow(/unknown key "publisher"/);
		expect(() => validateStoreBlock({ mode: 'usage' })).toThrow(/store\.mode must be free, subscription, paywall/);
		expect(() => validateStoreBlock({ icon: '../x.svg' })).toThrow(/store\.icon must stay inside/);
		expect(() => validateStoreBlock({ readme: '/etc/README.md' })).toThrow(/store\.readme must be a path relative/);
		expect(() => validateStoreBlock({ tags: ['a', 1] })).toThrow(/store\.tags must be a list of strings/);
		expect(() => validateStoreBlock({ links: { docs: 1 } })).toThrow(/store\.links/);
		expect(() => validateStoreBlock({ billing: { plans: [{ amountCents: 'free' }] } })).toThrow(/amountCents/);
		expect(() => validateStoreBlock([])).toThrow(/must be a JSON object/);
	});

	it('normalises billing plans the way the app listing does', () => {
		const block = validateStoreBlock({ billing: { plans: [{ nickname: 'Pro', amountCents: '900', metadata: { seats: 3 }, extra: true }] } });
		expect(block.billing?.plans).toEqual([{ nickname: 'Pro', amountCents: 900, currency: 'usd', interval: 'month', metadata: { seats: 3 }, extra: true }]);
	});

	it("applies the server door's declared-path, mode and billing-shape rules", () => {
		// What the server refuses as written, the client refuses first
		expect(() => validateStoreBlock({ icon: 'a/../icon.svg' })).toThrow(/store\.icon must stay inside/);
		expect(validateStoreBlock({ readme: ' docs/README.md ' }).readme).toBe('docs/README.md');
		expect(() => validateStoreBlock({ mode: ['free'] })).toThrow(/store\.mode must be/);
		expect(() => validateStoreBlock({ billing: { plans: [], currency: 'usd' } })).toThrow(/store\.billing: unknown key "currency"/);
		expect(() => validateStoreBlock({ billing: { plans: [null] } })).toThrow(/store\.billing\.plans must be a list of plan objects/);
	});
});

describe('scanReadmeReferences', () => {
	it('finds markdown images, links and HTML img in order, skipping URLs, anchors and code', () => {
		const md = [
			'# Doc Brain',
			'![flow](assets/flow.png "The flow")',
			'See [the guide](docs/guide.md#setup) and [the site](https://example.com/x.png).',
			'<img src="assets/shot%201.png?v=2" alt="shot"> <IMG SRC=\'assets/b.gif\'>',
			'<img alt="see src=\'x.png\'" src="y.png"> <img width=40 src=bare.png>',
			'[mail](mailto:a@b.c) [data](data:image/png;base64,AAAA) [proto](//cdn/x.png) [anchor](#top)',
			'![again](assets/flow.png)',
			'`![code](assets/nope.png)`',
			'```',
			'[fenced](assets/nope2.png)',
			'```',
		].join('\n');
		expect(scanReadmeReferences(md)).toEqual(['assets/flow.png', 'docs/guide.md', 'assets/shot 1.png', 'assets/b.gif', 'y.png', 'bare.png']);
	});

	it('takes reference definitions, angle-delimited destinations with spaces and balanced parentheses, and skips tilde fences', () => {
		const md = [
			'![Diagram][figure] and [the paper][ref]',
			'',
			'[figure]: assets/diagram.png',
			'[ref]: <https://example.com/paper.pdf> "Paper"',
			'[shot]: <assets/diagram one.png>',
			'![Two](<assets/plot two.png> "Two")',
			'![Plot](assets/plot(1).png)',
			'~~~markdown',
			'[Example](example.png)',
			'~~~',
		].join('\n');
		expect(scanReadmeReferences(md)).toEqual(['assets/diagram.png', 'assets/diagram one.png', 'assets/plot two.png', 'assets/plot(1).png']);
	});

	it('resolves references against the README and lays them out relative to the pipe', () => {
		const files = pipeStoreFiles({ readme: './docs/README.md', icon: 'icon.svg' }, '![a](../images/a.png) ![b](./b.png)', 'docs/README.md');
		expect(files).toEqual({ declared: ['docs/README.md', 'icon.svg'], referenced: ['images/a.png', 'docs/b.png'] });
		expect(pipeStoreFiles(null, null, null)).toEqual({ declared: [], referenced: [] });
	});
});

describe('packPipe', () => {
	it('packs the pipe, the declared files and the referenced files, nothing else, deterministically', () => {
		const folder = folderOf('docBrain', {
			'docBrain.pipe': pipeJson(STORE),
			'README.md': '# Doc Brain\n![flow](assets/flow.png)\n<img src="assets/nested/deep.png">\n[guide](docs/guide.md)\n',
			'icon.svg': '<svg/>',
			'assets/flow.png': Buffer.from([1, 2, 3]),
			'assets/nested/deep.png': Buffer.from([4]),
			'docs/guide.md': '# Guide\n',
			'notes.txt': 'not packed',
			'assets/unused.png': Buffer.from([5]),
		});
		const packed = packPipe(path.join(folder, 'docBrain.pipe'));
		expect(packed.pipeline.name).toBe('Doc Brain');
		expect(packed.store?.tagline).toBe('Reads documents');
		expect(packed.warnings).toEqual([]);
		expect(packed.files).toEqual(['docBrain.pipe', 'README.md', 'assets/flow.png', 'assets/nested/deep.png', 'docs/guide.md', 'icon.svg']);
		// adm-zip lists a read archive in its own order; the set is what it
		// can confirm, the write order is `files` and the determinism check
		const names = new AdmZip(Buffer.from(packed.data)).getEntries().map((e) => e.entryName);
		expect([...names].sort()).toEqual([...packed.files].sort());
		expect(Buffer.from(packPipe(path.join(folder, 'docBrain.pipe')).data).equals(Buffer.from(packed.data))).toBe(true);
	});

	it('preserves the layout of a nested README whose references climb to a sibling folder', () => {
		const folder = folderOf('docBrain', {
			'docBrain.pipe': pipeJson({ readme: 'docs/README.md' }),
			'docs/README.md': '![a](../images/a.png)',
			'images/a.png': Buffer.from([1]),
		});
		const packed = packPipe(path.join(folder, 'docBrain.pipe'));
		expect(packed.files).toEqual(['docBrain.pipe', 'docs/README.md', 'images/a.png']);
		expect(packed.warnings).toEqual(['store.icon is not declared, so tiles show a generic glyph']);
	});

	it('packs two pipes in one folder independently, sharing the icon', () => {
		const folder = folderOf('shared', {
			'a.pipe': pipeJson({ icon: 'icon.svg' }),
			'b.pipe': pipeJson({ icon: 'icon.svg', readme: 'b.md' }),
			'b.md': '# B\n',
			'icon.svg': '<svg/>',
		});
		expect(packPipe(path.join(folder, 'a.pipe')).files).toEqual(['a.pipe', 'icon.svg']);
		expect(packPipe(path.join(folder, 'b.pipe')).files).toEqual(['b.pipe', 'b.md', 'icon.svg']);
	});

	it('packs a pipe without a store block as the pipe alone, named after its stem', () => {
		const folder = folderOf('bare', { 'bare.pipe': JSON.stringify({ components: [] }), 'README.md': 'ignored' });
		const packed = packPipe(path.join(folder, 'bare.pipe'));
		expect(packed.store).toBeNull();
		expect(packed.files).toEqual(['bare.pipe']);
		expect(packed.pipeline.name).toBe('bare');
		expect(packed.warnings).toEqual([]);
	});

	it('refuses a missing declared file, a missing referenced file and an upward escape by name', () => {
		const declared = folderOf('d1', { 'd1.pipe': pipeJson({ icon: 'logo.png' }) });
		expect(() => packPipe(path.join(declared, 'd1.pipe'))).toThrow(/logo\.png does not exist beside the pipe/);
		const referenced = folderOf('d2', { 'd2.pipe': pipeJson({ readme: 'README.md' }), 'README.md': '![x](assets/missing.png)' });
		expect(() => packPipe(path.join(referenced, 'd2.pipe'))).toThrow(/assets\/missing\.png does not exist/);
		const escape = folderOf('d3', { 'd3.pipe': pipeJson({ readme: 'README.md' }), 'README.md': '![x](../secret.txt)' });
		fs.writeFileSync(path.join(ws, 'pipelines', 'secret.txt'), 'not yours');
		expect(() => packPipe(path.join(escape, 'd3.pipe'))).toThrow(/\.\.\/secret\.txt resolves outside/);
		// A sibling .pipe at the root would be a second artifact: the door takes exactly one
		const sibling = folderOf('d4', { 'd4.pipe': pipeJson({ readme: 'README.md' }), 'README.md': '[other](other.pipe)', 'other.pipe': '{}' });
		expect(() => packPipe(path.join(sibling, 'd4.pipe'))).toThrow(/other\.pipe is another pipeline at the root/);
	});

	it('refuses a symlink whose real location leaves the pipe directory', () => {
		const folder = folderOf('link', { 'link.pipe': pipeJson({ readme: 'README.md' }) });
		const secret = path.join(ws, 'secret.txt');
		fs.writeFileSync(secret, 'not yours');
		try {
			fs.symlinkSync(secret, path.join(folder, 'README.md'), 'file');
		} catch {
			return; // symlinks are not available to this process
		}
		expect(() => packPipe(path.join(folder, 'link.pipe'))).toThrow(/README\.md resolves outside/);
	});

	it('refuses a non-pipe, invalid JSON, an invalid block and an oversized readme', () => {
		const folder = folderOf('bad', { 'bad.json': '{}', 'broken.pipe': '{', 'block.pipe': pipeJson({ mode: 'usage' }), 'big.pipe': pipeJson({ readme: 'big.md' }), 'big.md': 'x'.repeat(1024 * 1024 + 1) });
		expect(() => packPipe(path.join(folder, 'bad.json'))).toThrow(/is not a \.pipe file/);
		expect(() => packPipe(path.join(folder, 'broken.pipe'))).toThrow(/not valid JSON/);
		expect(() => packPipe(path.join(folder, 'block.pipe'))).toThrow(/store\.mode/);
		expect(() => packPipe(path.join(folder, 'big.pipe'))).toThrow(/big\.md exceeds/);
	});
});

describe('scaffoldPipe', () => {
	it('writes the pipe with the default block, the shared icon, a README and assets/', () => {
		const created = scaffoldPipe(ws, 'ingest', { name: 'Document ingest' });
		expect(created).toEqual({ folder: 'pipelines/ingest', pipePath: 'pipelines/ingest/ingest.pipe', files: ['pipelines/ingest/ingest.pipe', 'pipelines/ingest/icon.svg', 'pipelines/ingest/README.md'] });
		const pipe = JSON.parse(fs.readFileSync(path.join(ws, 'pipelines', 'ingest', 'ingest.pipe'), 'utf8'));
		expect(pipe).toEqual({ components: [], project_id: 'ingest', name: 'Document ingest', description: '', store: defaultStoreBlock() });
		expect(fs.readFileSync(path.join(ws, 'pipelines', 'ingest', 'icon.svg'), 'utf8')).toBe(PLACEHOLDER_ICON_SVG);
		expect(PIPE_ICON_SVG).toBe(PLACEHOLDER_ICON_SVG);
		expect(fs.readFileSync(path.join(ws, 'pipelines', 'ingest', 'README.md'), 'utf8')).toMatch(/^# Document ingest\n[\s\S]*store listing/);
		expect(fs.statSync(path.join(ws, 'pipelines', 'ingest', 'assets')).isDirectory()).toBe(true);
		// The scaffold packs as-is: the block's declared files resolve
		expect(packPipe(path.join(ws, created.pipePath)).files).toEqual(['ingest.pipe', 'README.md', 'icon.svg']);
	});

	it('refuses an invalid id and an existing pipe, and honours --dir', () => {
		expect(() => scaffoldPipe(ws, 'acme.ingest')).toThrow(/invalid/);
		scaffoldPipe(ws, 'ingest');
		expect(() => scaffoldPipe(ws, 'ingest')).toThrow(/already exists/);
		expect(scaffoldPipe(ws, 'ingest', { dir: 'flows' }).pipePath).toBe('flows/ingest/ingest.pipe');
	});

	it('never replaces an existing asset and stays inside the workspace', () => {
		// An existing README beside a new pipe is kept (two pipes may share a folder)
		const folder = path.join(ws, 'pipelines', 'shared');
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, 'README.md'), '# Mine\n');
		expect(() => scaffoldPipe(ws, 'shared')).toThrow(/"pipelines\/shared\/README\.md" already exists/);
		expect(fs.readFileSync(path.join(folder, 'README.md'), 'utf8')).toBe('# Mine\n');
		expect(fs.existsSync(path.join(folder, 'shared.pipe'))).toBe(false);
		// A dir outside the workspace is refused before any write
		expect(() => scaffoldPipe(path.join(ws, 'inner'), 'ingest', { dir: '../outside' })).toThrow(/must resolve to a folder inside the workspace/);
		expect(fs.existsSync(path.join(ws, 'outside'))).toBe(false);
	});
});
