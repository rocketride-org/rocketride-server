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
 * The pipeline bundle packer (plan §9, B7): one folder, one .pipe, the
 * manifest, readme, icon and assets packed into the deploy zip.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { packPipeBundle, pipeBundleFolderOf, pipeOfBundle, readPipeManifest } from '../src/app-pack/index';

let ws: string;

beforeEach(() => {
	ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pipe-bundle-'));
});

afterEach(() => {
	fs.rmSync(ws, { recursive: true, force: true });
});

/** Writes one bundle folder with the given files and returns its path. */
function bundle(files: Record<string, string | Buffer>): string {
	const folder = path.join(ws, 'pipelines', 'docBrain');
	fs.mkdirSync(folder, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(folder, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	return folder;
}

const PIPE = JSON.stringify({ project_id: 'docBrain', components: [] });

describe('pipeBundleFolderOf', () => {
	it('accepts the folder and its only pipe, refuses a bare pipe beside others', () => {
		const folder = bundle({ 'docBrain.pipe': PIPE });
		expect(pipeBundleFolderOf(folder)).toBe(folder);
		expect(pipeBundleFolderOf(path.join(folder, 'docBrain.pipe'))).toBe(folder);
		fs.writeFileSync(path.join(folder, 'other.pipe'), PIPE);
		expect(pipeBundleFolderOf(path.join(folder, 'docBrain.pipe'))).toBeNull();
		expect(pipeBundleFolderOf(folder)).toBeNull();
		expect(pipeBundleFolderOf(path.join(ws, 'missing'))).toBeNull();
		expect(() => pipeOfBundle(folder)).toThrow(/2 \.pipe files/);
	});
});

describe('readPipeManifest', () => {
	it('is empty without a file, checked with one', () => {
		const folder = bundle({ 'docBrain.pipe': PIPE });
		expect(readPipeManifest(folder, 'docBrain')).toEqual({});
		fs.writeFileSync(path.join(folder, 'docBrain.rrpipe'), JSON.stringify({ name: 'Doc Brain', mode: 'paywall', tags: ['ocr'] }));
		expect(readPipeManifest(folder, 'docBrain').mode).toBe('paywall');
		fs.writeFileSync(path.join(folder, 'docBrain.rrpipe'), JSON.stringify({ publisher: 'acme' }));
		expect(() => readPipeManifest(folder, 'docBrain')).toThrow(/unknown key "publisher"/);
		fs.writeFileSync(path.join(folder, 'docBrain.rrpipe'), JSON.stringify({ mode: 'usage' }));
		expect(() => readPipeManifest(folder, 'docBrain')).toThrow(/mode must be/);
		fs.writeFileSync(path.join(folder, 'docBrain.rrpipe'), JSON.stringify({ icon: '../x.svg' }));
		expect(() => readPipeManifest(folder, 'docBrain')).toThrow(/inside the bundle/);
	});
});

describe('packPipeBundle', () => {
	it('packs the pipe, manifest, readme, icon and assets, nothing else, deterministically', () => {
		const folder = bundle({
			'docBrain.pipe': PIPE,
			'docBrain.rrpipe': JSON.stringify({ name: 'Doc Brain', tagline: 'Reads documents' }),
			'readme.md': '# Doc Brain\n![flow](assets/flow.png)\n',
			'icon.svg': '<svg/>',
			'assets/flow.png': Buffer.from([1, 2, 3]),
			'notes.txt': 'not packed',
		});
		const packed = packPipeBundle(folder);
		expect(packed.pipeline.name).toBe('Doc Brain');
		expect(packed.manifest.tagline).toBe('Reads documents');
		expect(packed.files).toEqual(['docBrain.pipe', 'docBrain.rrpipe', 'readme.md', 'icon.svg', 'assets/flow.png']);
		const names = new AdmZip(Buffer.from(packed.data)).getEntries().map((e) => e.entryName);
		expect(names).toEqual(packed.files);
		expect(Buffer.from(packPipeBundle(folder).data).equals(Buffer.from(packed.data))).toBe(true);
	});

	it('names a .pipe.json and orders assets by code point', () => {
		const legacy = bundle({ 'docBrain.pipe.json': PIPE });
		expect(() => pipeOfBundle(legacy)).toThrow(/rename it to docBrain\.pipe/);
		const folder = bundle({ 'docBrain.pipe': PIPE, 'assets/b.png': Buffer.from([1]), 'assets/B.png': Buffer.from([2]), 'assets/a.png': Buffer.from([3]) });
		expect(packPipeBundle(folder).files.slice(1)).toEqual(['assets/B.png', 'assets/a.png', 'assets/b.png']);
	});

	it('refuses a file whose real location leaves the bundle', () => {
		const folder = bundle({ 'docBrain.pipe': PIPE });
		const secret = path.join(ws, 'secret.txt');
		fs.writeFileSync(secret, 'not yours');
		try {
			fs.symlinkSync(secret, path.join(folder, 'readme.md'), 'file');
		} catch {
			return; // symlinks are not available to this process
		}
		expect(() => packPipeBundle(folder)).toThrow(/resolves outside the bundle folder/);
	});

	it('names the pipeline after the pipe, then the manifest, then the stem', () => {
		expect(packPipeBundle(bundle({ 'docBrain.pipe': PIPE })).pipeline.name).toBe('docBrain');
		expect(packPipeBundle(bundle({ 'docBrain.pipe': JSON.stringify({ name: 'From pipe' }) })).pipeline.name).toBe('From pipe');
	});

	it('refuses a manifest icon the bundle does not hold and an oversized readme', () => {
		const folder = bundle({ 'docBrain.pipe': PIPE, 'docBrain.rrpipe': JSON.stringify({ icon: 'logo.png' }) });
		expect(() => packPipeBundle(folder)).toThrow(/no such file/);
		const big = bundle({ 'docBrain.pipe': PIPE, 'readme.md': 'x'.repeat(1024 * 1024 + 1) });
		expect(() => packPipeBundle(big)).toThrow(/readme\.md exceeds/);
	});
});
