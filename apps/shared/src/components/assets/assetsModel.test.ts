// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// Unit tests: the pure half of PACKAGE › Assets (assetsModel).
//
// Pins the icon admission rule (type by media type or extension, the 256 KB
// cap), the README reference list resolved against the README's folder, the
// caret insertion grammar, the img-tag insert form and its width rewrite,
// the pasted-image naming and collision renames, the reference removal, the
// downscale size math, the path containment both hosts apply, and the
// base64 round trip bytes take over a webview bridge.
//
// Run via `shared:test` (node --import tsx --test), matching the package convention.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { admitIcon, assetMarkdown, base64ToBytes, besidePath, bytesToBase64, dataUriByteLength, downscaleImage, fitWithin, formatBytes, ICON_SIZE_MESSAGE, ICON_TYPE_MESSAGE, iconPathFor, imageDataUri, imageTag, inlineImageReferences, insertAtCaret, lineCount, MAX_ICON_BYTES, pastedImageName, readmeReferences, referenceWidth, removeReference, safeAssetName, setReferenceWidth, uniqueAssetName } from './assetsModel';

// =============================================================================
// ICON ADMISSION
// =============================================================================

test('admitIcon: svg and png by extension, by media type for a paste, nothing else', () => {
	assert.deepEqual(admitIcon({ name: 'logo.svg', size: 10 }), { kind: 'svg' });
	assert.deepEqual(admitIcon({ name: 'Logo.PNG', size: 10 }), { kind: 'png' });
	assert.deepEqual(admitIcon({ name: 'image', type: 'image/png', size: 10 }), { kind: 'png' });
	assert.deepEqual(admitIcon({ name: 'blob', type: 'image/svg+xml', size: 10 }), { kind: 'svg' });
	assert.deepEqual(admitIcon({ name: 'photo.jpg', size: 10 }), { error: ICON_TYPE_MESSAGE });
	assert.deepEqual(admitIcon({ name: 'photo', type: 'image/jpeg', size: 10 }), { error: ICON_TYPE_MESSAGE });
	assert.deepEqual(admitIcon({ name: 'readme.md', size: 10 }), { error: ICON_TYPE_MESSAGE });
});

test('admitIcon: the cap is 256 KB inclusive', () => {
	assert.deepEqual(admitIcon({ name: 'icon.png', size: MAX_ICON_BYTES }), { kind: 'png' });
	assert.deepEqual(admitIcon({ name: 'icon.png', size: MAX_ICON_BYTES + 1 }), { error: ICON_SIZE_MESSAGE });
});

test('iconPathFor: the declared path is the scaffold spelling', () => {
	assert.equal(iconPathFor('svg'), './icon.svg');
	assert.equal(iconPathFor('png'), './icon.png');
});

test('dataUriByteLength + formatBytes: base64 payloads decode to their byte count', () => {
	const bytes = new Uint8Array([1, 2, 3, 4, 5]);
	assert.equal(dataUriByteLength(imageDataUri('a.png', bytes) ?? ''), 5);
	assert.equal(dataUriByteLength('data:image/svg+xml;utf8,%3Csvg%3E'), 5);
	assert.equal(formatBytes(640), '640 B');
	assert.equal(formatBytes(1229), '1.2 KB');
	assert.equal(formatBytes(3 * 1024 * 1024 + 100_000), '3.1 MB');
});

// =============================================================================
// README REFERENCES
// =============================================================================

test('readmeReferences: resolved against the README folder, images flagged, duplicates and URLs dropped', () => {
	const md = '# T\n\n![a](assets/a.png) ![b](./assets/b.jpg)\n[doc](docs/guide.pdf) ![a again](assets/a.png)\n![web](https://x.test/p.png)\n<img src="assets/c.svg">';
	assert.deepEqual(readmeReferences(md, './README.md'), [
		{ ref: 'assets/a.png', relPath: 'assets/a.png', isImage: true },
		{ ref: './assets/b.jpg', relPath: 'assets/b.jpg', isImage: true },
		{ ref: 'docs/guide.pdf', relPath: 'docs/guide.pdf', isImage: false },
		{ ref: 'assets/c.svg', relPath: 'assets/c.svg', isImage: true },
	]);
	// A README in a subfolder resolves from there: one level up is still
	// inside the document's folder; an escape beyond it keeps its '..'
	assert.deepEqual(
		readmeReferences('![x](img/x.png) ![root](../root.png) ![up](../../outside.png)', 'docs/README.md').map((r) => r.relPath),
		['docs/img/x.png', 'root.png', '../outside.png']
	);
});

test('removeReference: images, links and html img tags go; the emptied line goes with them', () => {
	const md = 'Intro\n\n![shot](assets/shot.png)\n\nSee [the shot](assets/shot.png "title") here.\n<img src="assets/shot.png" alt="">\nEnd';
	assert.equal(removeReference(md, 'assets/shot.png'), 'Intro\n\n\nSee  here.\nEnd');
	assert.equal(removeReference(md, 'assets/other.png'), md);
});

test('inlineImageReferences: resolvable images become data URIs, others stay', async () => {
	const md = '![a](assets/a.png) ![b](assets/missing.png) <img src="assets/a.png">';
	const out = await inlineImageReferences(md, async (ref) => (ref === 'assets/a.png' ? 'data:image/png;base64,AAAA' : null));
	assert.equal(out, '![a](data:image/png;base64,AAAA) ![b](assets/missing.png) <img src="data:image/png;base64,AAAA">');
});

test('lineCount: a trailing newline adds no line; empty is one line', () => {
	assert.equal(lineCount(''), 1);
	assert.equal(lineCount('a'), 1);
	assert.equal(lineCount('a\nb\n'), 2);
	assert.equal(lineCount('a\n\nb'), 3);
});

// =============================================================================
// CARET INSERTION
// =============================================================================

test('insertAtCaret: mid-line insertions get their own line; line starts and ends do not double up', () => {
	assert.deepEqual(insertAtCaret('abc', 1, 'X'), { text: 'a\nX\nbc', caret: 3 });
	assert.deepEqual(insertAtCaret('abc\n', 4, 'X'), { text: 'abc\nX', caret: 5 });
	assert.deepEqual(insertAtCaret('abc\n\ndef', 4, 'X'), { text: 'abc\nX\ndef', caret: 5 });
	assert.deepEqual(insertAtCaret('', 0, 'X'), { text: 'X', caret: 1 });
	// The caret is clamped to the text
	assert.deepEqual(insertAtCaret('ab', 99, 'X'), { text: 'ab\nX', caret: 4 });
});

test('assetMarkdown: an img tag without width for image types, a link otherwise, alt = the stem', () => {
	assert.equal(assetMarkdown('assets/answer.png'), '<img src="assets/answer.png" alt="answer">');
	assert.equal(assetMarkdown('assets/guide.pdf'), '[guide](assets/guide.pdf)');
});

test('imageTag: width only when given, attribute values escaped', () => {
	assert.equal(imageTag('assets/a.svg', 'a', null), '<img src="assets/a.svg" alt="a">');
	assert.equal(imageTag('assets/a.svg', 'a "b"', 320.4), '<img src="assets/a.svg" alt="a &quot;b&quot;" width="320">');
	assert.equal(imageTag('assets/a.svg', 'a', 0), '<img src="assets/a.svg" alt="a">');
});

test('referenceWidth: read from the img tag; null for markdown images and tags without width', () => {
	assert.equal(referenceWidth('<img src="assets/a.png" alt="a" width="300">', 'assets/a.png'), 300);
	assert.equal(referenceWidth("<img width='120' src='assets/a.png'>", 'assets/a.png'), 120);
	assert.equal(referenceWidth('<img src="assets/a.png" alt="a">', 'assets/a.png'), null);
	assert.equal(referenceWidth('![a](assets/a.png)', 'assets/a.png'), null);
});

test('setReferenceWidth: markdown images convert to img, img tags keep other attributes, empty removes', () => {
	assert.equal(setReferenceWidth('see ![the shot](assets/a.png "t") here', 'assets/a.png', 400), 'see <img src="assets/a.png" alt="the shot" width="400"> here');
	assert.equal(setReferenceWidth('<img src="assets/a.png" alt="a" width="300" class="x">', 'assets/a.png', 200), '<img src="assets/a.png" alt="a" class="x" width="200">');
	assert.equal(setReferenceWidth('<img src="assets/a.png" alt="a" width="300">', 'assets/a.png', null), '<img src="assets/a.png" alt="a">');
	assert.equal(setReferenceWidth('<img src="assets/a.png" alt="a">', 'assets/a.png', null), '<img src="assets/a.png" alt="a">');
	// Every reference to the image changes; others do not
	assert.equal(setReferenceWidth('![a](assets/a.png) ![b](assets/b.png) <img src="assets/a.png">', 'assets/a.png', 50), '<img src="assets/a.png" alt="a" width="50"> ![b](assets/b.png) <img src="assets/a.png" width="50">');
	assert.equal(setReferenceWidth('nothing here', 'assets/a.png', 50), 'nothing here');
});

// =============================================================================
// DOWNSCALE
// =============================================================================

test('fitWithin: shrinks to the box with aspect kept, never grows, rounds to whole pixels', () => {
	assert.deepEqual(fitWithin(2048, 1000), { width: 1024, height: 500, scaled: true });
	assert.deepEqual(fitWithin(1000, 2000), { width: 400, height: 800, scaled: true });
	assert.deepEqual(fitWithin(3000, 3000), { width: 800, height: 800, scaled: true });
	assert.deepEqual(fitWithin(1024, 800), { width: 1024, height: 800, scaled: false });
	assert.deepEqual(fitWithin(640, 480), { width: 640, height: 480, scaled: false });
	assert.deepEqual(fitWithin(1025, 1), { width: 1024, height: 1, scaled: true });
	assert.deepEqual(fitWithin(0, 10), { width: 0, height: 10, scaled: false });
	assert.deepEqual(fitWithin(200, 100, 100, 100), { width: 100, height: 50, scaled: true });
});

test('downscaleImage: svg, gif and non-images pass through untouched', async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	assert.equal(await downscaleImage('a.svg', bytes), bytes);
	assert.equal(await downscaleImage('a.gif', bytes), bytes);
	assert.equal(await downscaleImage('a.pdf', bytes), bytes);
	// Under node (no createImageBitmap) a raster also passes through
	assert.equal(await downscaleImage('a.png', bytes), bytes);
});

// =============================================================================
// ASSET NAMING
// =============================================================================

test('safeAssetName: basename only, spaces to dashes, odd characters dropped', () => {
	assert.equal(safeAssetName('C:\\Users\\me\\My Shot (1).png'), 'My-Shot-1.png');
	assert.equal(safeAssetName('../../evil.png'), 'evil.png');
	assert.equal(safeAssetName('.hidden'), 'hidden');
	assert.equal(safeAssetName('***'), 'file');
});

test('pastedImageName: <docStem>-<n>.png', () => {
	assert.equal(pastedImageName('myPipe', 1), 'myPipe-1.png');
	assert.equal(pastedImageName('my app', 3), 'my-app-3.png');
});

test('uniqueAssetName: collisions get -2, -3 before the extension', async () => {
	const taken = new Set(['shot.png', 'shot-2.png']);
	const exists = async (name: string): Promise<boolean> => taken.has(name);
	assert.equal(await uniqueAssetName('fresh.png', exists), 'fresh.png');
	assert.equal(await uniqueAssetName('shot.png', exists), 'shot-3.png');
	assert.equal(await uniqueAssetName('noext', async (n) => n === 'noext'), 'noext-2');
});

// =============================================================================
// CONTAINMENT
// =============================================================================

test('besidePath: normalised, inside the folder, null on escape or empty', () => {
	assert.equal(besidePath('./README.md'), 'README.md');
	assert.equal(besidePath('assets\\..\\assets\\x.png'), 'assets/x.png');
	assert.equal(besidePath('a/../../x'), null);
	assert.equal(besidePath('../x'), null);
	assert.equal(besidePath('.'), null);
	assert.equal(besidePath(''), null);
});

// =============================================================================
// BYTES ON THE WIRE
// =============================================================================

test('bytesToBase64 / base64ToBytes round-trip, including a chunk boundary', () => {
	const bytes = new Uint8Array(0x8000 + 7);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
	assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
	assert.equal(bytesToBase64(new Uint8Array([104, 105])), 'aGk=');
});

test('imageDataUri: media type by extension, null for a non-image', () => {
	assert.equal(imageDataUri('x.svg', new Uint8Array([60])), 'data:image/svg+xml;base64,PA==');
	assert.equal(imageDataUri('x.txt', new Uint8Array([60])), null);
});
