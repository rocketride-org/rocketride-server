// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// HIGHLIGHT: the query's words marked in a chunk's text, as segments (never HTML)
// =============================================================================
//
// The chunk text panel marks the words of the active query in the chunk's
// full text: case-insensitive, with a light suffix strip (water / waters /
// watering), stop-words left out. The answer is a list of text segments that
// joins back to the text exactly; nothing is ever turned into markup, so a
// chunk that contains '<b>' or '&amp;' is shown as those characters.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK_TEXT_MAX, STOP_WORDS, clampText, highlightSegments, markedWords, queryTerms, queryWords, stem } from '../src/vector/highlight';
import type { ITextSegment } from '../src/vector/highlight';
import { bestOf } from './support/timing';

/** The marked words of a segment list, in order. */
const marked = (segments: readonly ITextSegment[]): string[] => segments.filter((s) => s.mark).map((s) => s.text);
/** The segments joined back. */
const joined = (segments: readonly ITextSegment[]): string => segments.map((s) => s.text).join('');

test('the query terms: lower-cased, stop-words and one-letter words left out, each stem once, in query order', () => {
	assert.deepEqual(queryTerms('Where does Falcon Station get its water?'), ['falcon', 'station', 'water']);
	assert.deepEqual(queryTerms('the WATER, the waters and watering'), ['water']);
	assert.deepEqual(queryTerms('a b c'), []);
	assert.deepEqual(queryTerms(''), []);
	assert.deepEqual(queryTerms(null), []);
	assert.deepEqual(queryTerms('KX4471 code'), ['kx4471', 'code']);
	for (const word of ['the', 'and', 'where', 'does', 'its', 'what', 'is']) assert.ok(STOP_WORDS.has(word), word);
});

test('the light suffix strip: plurals, -ing, -ed, -ies and a final e meet on one stem; other words stay apart', () => {
	assert.equal(stem('water'), 'water');
	assert.equal(stem('Waters'), 'water');
	assert.equal(stem('watering'), 'water');
	assert.equal(stem('watered'), 'water');
	assert.equal(stem('stations'), 'station');
	assert.equal(stem('station’s'), 'station');
	assert.equal(stem('stories'), 'story');
	assert.equal(stem('running'), 'run');
	assert.equal(stem('changes'), stem('changed'));
	assert.equal(stem('boxes'), 'box');
	assert.equal(stem('glass'), 'glass', 'a double s is not a plural');
	assert.equal(stem('gas'), 'gas', 'short words are kept as they are');
	assert.notEqual(stem('stationary'), stem('station'), 'a longer word is not a match');
});

test('segments mark the query words case-insensitively and join back to the text exactly', () => {
	const text = 'Drinking water at Falcon Station comes from the Kestrel spring; the station waters the greenhouse.';
	const segments = highlightSegments(text, 'Where does Falcon Station get its water?');
	assert.equal(joined(segments), text);
	assert.deepEqual(marked(segments), ['water', 'Falcon', 'Station', 'station', 'waters']);
	assert.equal(markedWords(segments), 5);
	assert.ok(
		segments.every((s) => typeof s.text === 'string' && typeof s.mark === 'boolean' && Object.keys(s).length === 2),
		'plain text segments, nothing else'
	);
	assert.ok(
		segments.every((s, i) => i === 0 || s.mark || segments[i - 1]!.mark),
		'unmarked runs are merged'
	);
});

test('never HTML: markup in the chunk stays characters, and a query cannot inject any', () => {
	const text = '<b>water</b> &amp; <script>alert(1)</script> water';
	const segments = highlightSegments(text, 'water <img src=x onerror=alert(1)>');
	assert.equal(joined(segments), text);
	assert.deepEqual(marked(segments), ['water', 'alert', 'water']);
	assert.ok(!segments.some((s) => s.mark && /[<>&]/.test(s.text)), 'a mark holds one word');
});

test('no query, or one of stop-words only, marks nothing; empty text gives no segment', () => {
	assert.deepEqual(highlightSegments('Falcon Station water', null), [{ text: 'Falcon Station water', mark: false }]);
	assert.deepEqual(highlightSegments('Falcon Station water', 'the and of'), [{ text: 'Falcon Station water', mark: false }]);
	assert.deepEqual(highlightSegments('', 'water'), []);
});

test('words are whole: letters of any script and digits, apostrophes inside a word; a part of a word is never marked', () => {
	const segments = highlightSegments('Café crème at the café; the stationary station; code KX4471-B; it’s the station’s', 'café station kx4471');
	assert.deepEqual(marked(segments), ['Café', 'café', 'station', 'KX4471', 'station’s']);
	assert.deepEqual(marked(highlightSegments('Größe der Station', 'größe')), ['Größe']);
});

test('the panel shows at most 20,000 characters of a chunk and says when it cut', () => {
	assert.equal(CHUNK_TEXT_MAX, 20000);
	assert.deepEqual(clampText('short'), { text: 'short', truncated: false });
	const long = 'x'.repeat(CHUNK_TEXT_MAX + 5);
	const clamped = clampText(long);
	assert.equal(clamped.text.length, CHUNK_TEXT_MAX);
	assert.equal(clamped.truncated, true);
	const { ms } = bestOf(() => highlightSegments(`${'water station spring intake '.repeat(800)}`.slice(0, CHUNK_TEXT_MAX), 'water spring intake falcon'));
	assert.ok(ms < 50, 'a full-size chunk is segmented within a frame budget');
});

test("the words the panel names are the query's own (lower-cased, one per stem), not the stems", () => {
	assert.deepEqual(queryWords('Changes to the watering of Falcon’s station; changed water'), ['changes', 'watering', 'falcon', 'station']);
	assert.deepEqual(queryWords(null), []);
	assert.deepEqual(queryTerms('Changes to the watering'), ['chang', 'water']);
});

test('scripts without case are marked too: whole words where words are spaced, the query word inside a run where they are not', () => {
	assert.deepEqual(marked(highlightSegments('محطة المياه في الشمال', 'المياه')), ['المياه'], 'Arabic');
	assert.deepEqual(marked(highlightSegments('תחנת המים בצפון', 'המים')), ['המים'], 'Hebrew');
	assert.deepEqual(marked(highlightSegments('पानी की टंकी', 'पानी')), ['पानी'], 'Devanagari');
	assert.deepEqual(marked(highlightSegments('수도 시설 점검', '시설')), ['시설'], 'Hangul');
	assert.deepEqual(marked(highlightSegments('관측소의 물 품질', '물')), ['물'], 'one Hangul syllable is a word');
	assert.deepEqual(queryTerms('a b x'), [], 'one Latin letter is still no word');
	assert.deepEqual(marked(highlightSegments('水资源管理和水质', '水质')), ['水质'], 'Chinese: the query word inside a run');
	assert.deepEqual(marked(highlightSegments('給水設備の点検', '点検')), ['点検'], 'Japanese');
	assert.deepEqual(marked(highlightSegments('สถานีน้ำประปา', 'น้ำ')), ['น้ำ'], 'Thai');
	assert.deepEqual(marked(highlightSegments('水', '水')), ['水'], 'one ideograph is a word');
	for (const [text, query] of [
		['水资源管理和水质', '水质'],
		['محطة المياه', 'المياه'],
	] as const) {
		assert.equal(
			highlightSegments(text, query)
				.map((s) => s.text)
				.join(''),
			text,
			'the segments join back to the text'
		);
	}
});

test('a cut text never splits a character that takes two UTF-16 units', () => {
	const text = `${'x'.repeat(CHUNK_TEXT_MAX - 1)}😀tail`;
	const clamped = clampText(text);
	assert.equal(clamped.truncated, true);
	assert.equal(clamped.text, 'x'.repeat(CHUNK_TEXT_MAX - 1), 'the emoji that would be cut in half is left out whole');
	assert.ok(!/[\uD800-\uDBFF]$/.test(clamped.text));
});

test('punctuation of those scripts ends a word: an Arabic question mark, a Hebrew maqaf, a Devanagari danda', () => {
	assert.deepEqual(marked(highlightSegments('أين المياه؟ هنا', 'المياه')), ['المياه']);
	assert.deepEqual(marked(highlightSegments('בית־המים', 'המים')), ['המים']);
	assert.deepEqual(marked(highlightSegments('पानी। अब', 'पानी')), ['पानी']);
	assert.deepEqual(marked(highlightSegments('٢٠٢٦ المياه', '٢٠٢٦')), ['٢٠٢٦'], 'Arabic-Indic digits are a word');
});
