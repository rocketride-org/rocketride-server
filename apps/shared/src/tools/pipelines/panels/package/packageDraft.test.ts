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

/** The PACKAGE page's draft: the patch over the document and the pending-file overlay. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IAssetsHost } from '../../../../components/assets';
import { applyPatch, isEmptyPatch, mergeChange, overlayAssetsHost, patchOf, pendingDataUri, prunePatch } from './packageDraft';
import type { PendingFiles } from './packageDraft';

/** A document with one of every key the panes write, plus the canvas's own. */
const DOCUMENT = {
	project_id: 'docBrain',
	name: 'Doc brain',
	description: '',
	source: 'webhook_1',
	parameters: { maxEdge: 'llm_1.max_edge' },
	store: { tagline: '', mode: 'free', readme: './README.md' },
	components: [{ id: 'webhook_1' }, { id: 'llm_1' }],
	docRevision: 4,
};

/** A host over a fixed set of files that records what reaches it. */
function fakeHost(files: Record<string, string>): { host: IAssetsHost; written: string[]; opened: string[] } {
	const written: string[] = [];
	const opened: string[] = [];
	const host: IAssetsHost = {
		readFile: async (relPath) => files[relPath.replace(/^\.\//, '')] ?? null,
		readImageDataUri: async (relPath) => (relPath.replace(/^\.\//, '') in files ? `data:image/png;base64,${relPath}` : null),
		writeFile: async (relPath) => {
			written.push(relPath);
		},
		pickFile: async () => null,
		openFile: async (relPath) => {
			opened.push(relPath);
		},
	};
	return { host, written, opened };
}

describe('patchOf', () => {
	it('holds only the PACKAGE keys a pane changed', () => {
		const next = { ...DOCUMENT, description: 'Answers from your documents', docRevision: 5, components: [] };
		assert.deepEqual(patchOf(DOCUMENT, next), { description: 'Answers from your documents' });
	});

	it('is empty when a pane wrote the document back unchanged', () => {
		const next = { ...DOCUMENT, store: { tagline: '', mode: 'free', readme: './README.md' }, docRevision: 5 };
		assert.equal(isEmptyPatch(patchOf(DOCUMENT, next)), true);
	});

	it('records a removed key as a pending removal', () => {
		const next: Record<string, unknown> = { ...DOCUMENT };
		delete next.source;
		const patch = patchOf(DOCUMENT, next);
		assert.equal('source' in patch, true);
		assert.equal(patch.source, undefined);
	});

	it('reads a reordered map as a change: the order is what the reader sees', () => {
		const document = { ...DOCUMENT, parameters: { a: 'llm_1.a', b: 'llm_1.b' } };
		const next = { ...document, parameters: { b: 'llm_1.b', a: 'llm_1.a' } };
		assert.deepEqual(Object.keys(patchOf(document, next)), ['parameters']);
	});
});

describe('mergeChange', () => {
	it('adds the keys a pane changed and keeps the rest of the draft', () => {
		const shown = { ...DOCUMENT, name: 'Brain' };
		const next = { ...shown, description: 'New words', docRevision: 5 };
		assert.deepEqual(mergeChange({ name: 'Brain' }, shown, next), { name: 'Brain', description: 'New words' });
	});

	it('keeps an edit made since a late pane was shown its document', () => {
		// The Assets pane was shown the document before a name was typed on Identity; its icon path arrives after
		const shown = DOCUMENT;
		const next = { ...shown, store: { ...shown.store, icon: './icon.png' } };
		const merged = mergeChange({ name: 'Typed since' }, shown, next);
		assert.deepEqual(merged, { name: 'Typed since', store: { tagline: '', mode: 'free', readme: './README.md', icon: './icon.png' } });
	});

	it('answers the same draft when the pane wrote back what it was shown', () => {
		const draft = { name: 'Brain' };
		assert.equal(mergeChange(draft, DOCUMENT, { ...DOCUMENT, docRevision: 9 }), draft);
	});

	it('merges a removal as a pending removal', () => {
		const next: Record<string, unknown> = { ...DOCUMENT };
		delete next.source;
		const merged = mergeChange({ name: 'Brain' }, DOCUMENT, next);
		assert.equal('source' in merged, true);
		assert.equal(merged.source, undefined);
		assert.equal(merged.name, 'Brain');
	});
});

describe('applyPatch', () => {
	it('replaces pending keys, deletes pending removals and keeps the rest', () => {
		const applied = applyPatch(DOCUMENT, { name: 'Brain', source: undefined });
		assert.equal(applied.name, 'Brain');
		assert.equal('source' in applied, false);
		assert.equal(applied.components, DOCUMENT.components);
		assert.equal(applied.docRevision, 4);
	});

	it('answers the same object for an empty patch', () => {
		assert.equal(applyPatch(DOCUMENT, {}), DOCUMENT);
	});
});

describe('prunePatch', () => {
	it('drops the keys the document caught up with', () => {
		const patch = { name: 'Brain', description: 'New words' };
		const saved = { ...DOCUMENT, name: 'Brain' };
		assert.deepEqual(prunePatch(saved, patch), { description: 'New words' });
	});

	it('answers the same object when nothing caught up', () => {
		const patch = { name: 'Brain' };
		assert.equal(prunePatch(DOCUMENT, patch), patch);
	});

	it('drops a pending removal once the key is gone', () => {
		const saved: Record<string, unknown> = { ...DOCUMENT };
		delete saved.source;
		assert.equal(isEmptyPatch(prunePatch(saved, { source: undefined })), true);
	});
});

describe('pendingDataUri', () => {
	it('encodes image bytes under the media type of the extension', () => {
		assert.equal(pendingDataUri('assets/shot.PNG', new Uint8Array([1, 2, 3])), 'data:image/png;base64,AQID');
	});

	it('encodes SVG text', () => {
		assert.equal(pendingDataUri('icon.svg', '<svg/>'), `data:image/svg+xml;base64,${btoa('<svg/>')}`);
	});

	it('answers null for a file that is not an image', () => {
		assert.equal(pendingDataUri('README.md', '# Title'), null);
	});
});

describe('overlayAssetsHost', () => {
	it('keeps a write in the draft and never reaches the file', async () => {
		const { host, written } = fakeHost({ 'README.md': 'on disk' });
		const pending: PendingFiles = new Map();
		let changes = 0;
		const overlay = overlayAssetsHost(host, pending, () => {
			changes += 1;
		});
		await overlay.writeFile('./README.md', 'typed');
		assert.deepEqual(written, []);
		assert.deepEqual([...pending], [['README.md', 'typed']]);
		assert.equal(changes, 1);
	});

	it('reads pending content first, under any spelling of the path', async () => {
		const { host } = fakeHost({ 'README.md': 'on disk', 'assets/old.png': 'x' });
		const pending: PendingFiles = new Map();
		const overlay = overlayAssetsHost(host, pending, () => undefined);
		assert.equal(await overlay.readFile('./README.md'), 'on disk');
		await overlay.writeFile('README.md', 'typed');
		assert.equal(await overlay.readFile('./README.md'), 'typed');
		await overlay.writeFile('assets/new.png', new Uint8Array([1, 2, 3]));
		assert.equal(await overlay.readImageDataUri('./assets/new.png'), 'data:image/png;base64,AQID');
		assert.equal(await overlay.readImageDataUri('assets/old.png'), 'data:image/png;base64,assets/old.png');
		assert.equal(await overlay.readFile('assets/missing.png'), null);
	});

	it('answers a pending binary to a text read, so a taken name reads as taken', async () => {
		const { host } = fakeHost({});
		const overlay = overlayAssetsHost(host, new Map(), () => undefined);
		await overlay.writeFile('assets/shot.png', new Uint8Array([65, 66]));
		assert.equal(await overlay.readFile('assets/shot.png'), 'AB');
	});

	it('refuses a write outside the folder', async () => {
		const { host } = fakeHost({});
		const overlay = overlayAssetsHost(host, new Map(), () => undefined);
		await assert.rejects(overlay.writeFile('../other.md', 'x'), /not a path beside the pipeline/);
	});

	it('opens a file in the editor only while it has no pending content', async () => {
		const { host, opened } = fakeHost({ 'README.md': 'on disk' });
		const overlay = overlayAssetsHost(host, new Map(), () => undefined);
		await overlay.openFile?.('./README.md');
		assert.deepEqual(opened, ['./README.md']);
		await overlay.writeFile('./README.md', 'typed');
		await assert.rejects(overlay.openFile?.('./README.md') ?? Promise.resolve(), /README\.md has unsaved changes here/);
	});

	it('offers no editor on a host without one', () => {
		const { host } = fakeHost({});
		const { openFile: _editor, ...noEditor } = host;
		assert.equal(overlayAssetsHost(noEditor, new Map(), () => undefined).openFile, undefined);
	});
});
