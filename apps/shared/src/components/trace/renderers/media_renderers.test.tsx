// =============================================================================
// Unit tests: media lane guards, wrap∘check composition, and the JsonTree cap.
//
// These pin the bug fixed on this branch: the media lanes' final-result entries
// {mime_type, <lane>, metadata?} (and #1374's {mime_type, path}) must be recognised
// by their guards AND survive the render_final wrap, or they drop to the JsonTree
// fallback — which must, in turn, never emit an unbounded string.
//
// Run via `shared:test` (node --import tsx --test), matching the package convention.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { LANE_RENDERERS } from './render_final';
import { isAudio } from './render_audio';
import { isVideo } from './render_video';
import { isImage } from './render_image';
import { JsonTree } from '../JsonTree';

type Lane = 'image' | 'audio' | 'video';
const LANES: Lane[] = ['image', 'audio', 'video'];
const guards: Record<Lane, (d: unknown) => boolean> = { image: isImage, audio: isAudio, video: isVideo };
const laneRenderer = (lane: Lane) => LANE_RENDERERS.find((r) => r.type === lane)!;

// The root cause: a wrap the guard can't recognise silently drops to JsonTree.
for (const lane of LANES) {
	test(`${lane}: render_final wrap ∘ check accepts the result entry`, () => {
		const r = laneRenderer(lane);
		assert.equal(r.check(r.wrap(lane, { mime_type: `${lane}/x`, [lane]: 'QUJD' })), true);
	});
}

// Guard shape matrix. Stream/metadata rows are regression guards: the live AVI
// trace dispatch (renderers/index.tsx) relies on these same guards.
for (const lane of LANES) {
	test(`${lane} guard: accepts base64, metadata, path, and stream shapes; rejects the rest`, () => {
		const g = guards[lane];
		assert.equal(g({ mime_type: `${lane}/x`, [lane]: 'QUJD' }), true, 'base64');
		assert.equal(g({ mime_type: `${lane}/x`, [lane]: 'QUJD', metadata: { name: 'n' } }), true, 'base64+metadata');
		assert.equal(g({ mime_type: `${lane}/x`, path: 'outputs/x' }), true, 'path (#1374)');
		assert.equal(g({ action: 0, mimeType: `${lane}/x` }), true, 'live AVI stream BEGIN');
		assert.equal(g({ mime_type: `${lane}/x` }), false, 'mime alone');
		for (const junk of [null, undefined, 'x', 42, []]) assert.equal(g(junk), false, `junk ${String(junk)}`);
	});
}

test('image guard still accepts its {format, width} metadata shape', () => {
	assert.equal(isImage({ format: 'png', width: 10 }), true);
});
test('audio guard still accepts its {format, duration_seconds} metadata shape', () => {
	assert.equal(isAudio({ format: 'mp3', duration_seconds: 90 }), true);
});
test('audio guard rejects the legacy {url, aviAction, size} tracking dict', () => {
	assert.equal(isAudio({ url: 'u', aviAction: '0', mimeType: 'audio/mpeg', size: 0 }), false);
});

// Renderers emit real players (base64) or a path row (#1374 shape).
test('video base64 renders <video>', () => {
	assert.match(renderToStaticMarkup(laneRenderer('video').render({ mime_type: 'video/mp4', video: 'QUJD' })), /<video/);
});
test('audio base64 renders <audio>', () => {
	assert.match(renderToStaticMarkup(laneRenderer('audio').render({ mime_type: 'audio/mpeg', audio: 'QUJD' })), /<audio/);
});
test('image base64 renders <img>', () => {
	assert.match(renderToStaticMarkup(laneRenderer('image').render({ mime_type: 'image/png', image: 'QUJD' })), /<img/);
});
test('path shape shows the path and no player', () => {
	const html = renderToStaticMarkup(laneRenderer('video').render({ mime_type: 'video/mp4', path: 'outputs/v.mp4' }));
	assert.match(html, /outputs\/v\.mp4/);
	assert.doesNotMatch(html, /<video/);
});

// The safety net: JsonTree must never write a megabyte string into one node.
test('JsonTree caps a 5MB leaf string far below its own length', () => {
	const html = renderToStaticMarkup(createElement(JsonTree, { data: { mime_type: 'video/mp4', video: 'A'.repeat(5_000_000) } }));
	assert.ok(html.length < 5000, `expected capped output, got ${html.length}`);
});
