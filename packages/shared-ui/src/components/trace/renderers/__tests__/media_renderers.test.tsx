// =============================================================================
// Unit tests: media lane guards, wrap∘check composition, and the JsonTree cap.
//
// These pin the bug fixed on this branch: the media lanes' final-result entries
// {mime_type, <lane>, metadata?} (and #1374's {mime_type, path}) must be recognised
// by their guards AND survive the render_final wrap, or they drop to the JsonTree
// fallback — which must, in turn, never emit an unbounded string.
// =============================================================================

import { describe, it, expect } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { LANE_RENDERERS } from '../render_final';
import { isAudio } from '../render_audio';
import { isVideo } from '../render_video';
import { isImage } from '../render_image';
import { JsonTree } from '../../JsonTree';

type Lane = 'image' | 'audio' | 'video';
const LANES: Lane[] = ['image', 'audio', 'video'];
const guards = { image: isImage, audio: isAudio, video: isVideo };
const laneRenderer = (lane: Lane) => LANE_RENDERERS.find((r) => r.type === lane)!;

// -----------------------------------------------------------------------------
// The root cause: a wrap the guard can't recognise silently drops to JsonTree.
// -----------------------------------------------------------------------------
describe('render_final: wrap ∘ check composes for every media lane', () => {
	it.each(LANES)('%s: the wrapped result entry passes its own guard', (lane) => {
		const r = laneRenderer(lane);
		const entry = { mime_type: `${lane}/x`, [lane]: 'QUJD' };
		expect(r.check(r.wrap(lane, entry))).toBe(true);
	});
});

// -----------------------------------------------------------------------------
// Guard shape matrix. Rows for stream/metadata shapes are regression guards:
// the live AVI trace dispatch (renderers/index.tsx) relies on them.
// -----------------------------------------------------------------------------
describe('media guards accept result shapes and preserve stream/metadata shapes', () => {
	it.each(LANES)('%s: accepts {mime_type, <lane>} base64 entry', (lane) => {
		expect(guards[lane]({ mime_type: `${lane}/x`, [lane]: 'QUJD' })).toBe(true);
	});
	it.each(LANES)('%s: accepts base64 entry with metadata', (lane) => {
		expect(guards[lane]({ mime_type: `${lane}/x`, [lane]: 'QUJD', metadata: { name: 'n' } })).toBe(true);
	});
	it.each(LANES)('%s: accepts {mime_type, path} entry (#1374 shape)', (lane) => {
		expect(guards[lane]({ mime_type: `${lane}/x`, path: 'outputs/x' })).toBe(true);
	});
	it.each(LANES)('%s: still accepts the live AVI stream BEGIN event', (lane) => {
		expect(guards[lane]({ action: 0, mimeType: `${lane}/x` })).toBe(true);
	});
	it.each(LANES)('%s: rejects mime_type alone (no payload/path)', (lane) => {
		expect(guards[lane]({ mime_type: `${lane}/x` })).toBe(false);
	});
	it.each(LANES)('%s: rejects non-objects and empties', (lane) => {
		for (const junk of [null, undefined, 'x', 42, []]) {
			expect(guards[lane](junk)).toBe(false);
		}
	});

	it('image still accepts its {format, width} metadata shape', () => {
		expect(isImage({ format: 'png', width: 10 })).toBe(true);
	});
	it('audio still accepts its {format, duration_seconds} metadata shape', () => {
		expect(isAudio({ format: 'mp3', duration_seconds: 90 })).toBe(true);
	});
	it('audio rejects the legacy {url, aviAction, size} tracking dict', () => {
		expect(isAudio({ url: 'u', aviAction: '0', mimeType: 'audio/mpeg', size: 0 })).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Renderers emit real players (base64) or a path row (#1374 shape).
// -----------------------------------------------------------------------------
describe('renderers emit media elements, not a JSON dump', () => {
	it('video base64 → <video>', () => {
		const html = renderToStaticMarkup(laneRenderer('video').render({ mime_type: 'video/mp4', video: 'QUJD' }));
		expect(html).toContain('<video');
	});
	it('audio base64 → <audio>', () => {
		const html = renderToStaticMarkup(laneRenderer('audio').render({ mime_type: 'audio/mpeg', audio: 'QUJD' }));
		expect(html).toContain('<audio');
	});
	it('image base64 → <img>', () => {
		const html = renderToStaticMarkup(laneRenderer('image').render({ mime_type: 'image/png', image: 'QUJD' }));
		expect(html).toContain('<img');
	});
	it('path shape → shows the path, no player', () => {
		const html = renderToStaticMarkup(laneRenderer('video').render({ mime_type: 'video/mp4', path: 'outputs/v.mp4' }));
		expect(html).toContain('outputs/v.mp4');
		expect(html).not.toContain('<video');
	});
});

// -----------------------------------------------------------------------------
// The safety net: JsonTree must never write a megabyte string into one node.
// -----------------------------------------------------------------------------
describe('JsonTree caps leaf strings', () => {
	it('a 5MB payload renders far below its own length', () => {
		const html = renderToStaticMarkup(
			createElement(JsonTree, { data: { mime_type: 'video/mp4', video: 'A'.repeat(5_000_000) } }),
		);
		expect(html.length).toBeLessThan(5000);
	});
});
