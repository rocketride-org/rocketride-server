// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Reading close bodies (core/results.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellText, firstRecord, lanesOf, mediaSource, plainTextOf, readAnswer, readDocument } from '../src/core/results';

test('lanesOf: result_types order, every field as a list, missing fields left out', () => {
	const lanes = lanesOf({ result_types: { answers: 'answers', images: 'image', gone: 'text' }, answers: ['hi'], images: { mime_type: 'image/png', image: 'AAA' } });
	assert.deepEqual(
		lanes.map((l) => [l.key, l.type, l.items.length]),
		[
			['answers', 'answers', 1],
			['images', 'image', 1],
		]
	);
	assert.deepEqual(lanesOf({}), []);
	assert.deepEqual(lanesOf(undefined), []);
});

test('readAnswer: objects and JSON-object strings are records; everything else is text', () => {
	assert.deepEqual(readAnswer({ total: 4431 }), { kind: 'record', record: { total: 4431 } });
	assert.deepEqual(readAnswer('{"vendor": "Globex"}'), { kind: 'record', record: { vendor: 'Globex' } });
	assert.deepEqual(readAnswer('{not json}'), { kind: 'text', text: '{not json}' });
	assert.deepEqual(readAnswer('Contractors are not covered.'), { kind: 'text', text: 'Contractors are not covered.' });
});

test('firstRecord: only when every item is a record', () => {
	assert.deepEqual(firstRecord([{ a: 1 }, '{"a": 2}']), { a: 1 });
	assert.equal(firstRecord([{ a: 1 }, 'text']), null);
});

test('cellText: scalars as they are, arrays counted, objects as JSON', () => {
	assert.equal(cellText(4431.0), '4431');
	assert.equal(cellText([1, 2, 3]), '3 items');
	assert.equal(cellText([1]), '1 item');
	assert.equal(cellText({ a: 1 }), '{"a":1}');
	assert.equal(cellText(null), '');
});

test('mediaSource: base64 becomes a data URL; a link stays a link', () => {
	assert.deepEqual(mediaSource('image', { mime_type: 'image/png', image: 'iVBOR' }), { src: 'data:image/png;base64,iVBOR', isLink: false, mime: 'image/png', name: undefined });
	assert.equal(mediaSource('video', { mime_type: 'video/mp4', video: 'https://store.example/v.mp4?sig=1' }).isLink, true);
	assert.equal(mediaSource('audio', { mime_type: 'audio/mpeg', url: '/task/fetch?token=x' }).src, '/task/fetch?token=x');
	assert.equal(mediaSource('image', { mime_type: 'image/png', path: '/spool/x' }).src, null);
});

test('mediaSource: base64 in the lane that starts with a slash is data, not a server path', () => {
	// a JPEG's base64 begins '/9j/', an MP3 frame's '//'
	assert.deepEqual(mediaSource('image', { mime_type: 'image/jpeg', image: '/9j/4AAQSkZJRg==' }), { src: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', isLink: false, mime: 'image/jpeg', name: undefined });
	assert.equal(mediaSource('audio', { mime_type: 'audio/mpeg', audio: '//uQxAAAAAAA' }).isLink, false);
	// a server path in the lane holds a character base64 never does, and stays a link
	assert.deepEqual(mediaSource('image', { mime_type: 'image/png', image: '/task/fetch?token=x' }), { src: '/task/fetch?token=x', isLink: true, mime: 'image/png', name: undefined });
	assert.equal(mediaSource('image', { mime_type: 'image/png', image: 'https://store.example/a.png' }).isLink, true);
});

test('readDocument: the parent file name, the passage, chunk and score', () => {
	assert.deepEqual(readDocument({ page_content: 'Leave is…', score: 0.82, metadata: { parent: '/policies/HR-Policy-Leave-2026.pdf', chunkId: 4 } }), {
		file: 'HR-Policy-Leave-2026.pdf',
		text: 'Leave is…',
		chunk: 4,
		score: 0.82,
	});
});

test('plainTextOf: text lanes and text answers, records as JSON', () => {
	assert.equal(plainTextOf({ result_types: { answers: 'answers', text: 'text' }, answers: ['A', { b: 1 }], text: ['T'] }), 'A\n\n{"b":1}\n\nT');
});
