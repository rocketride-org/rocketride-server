// =============================================================================
// MIT License
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

// =============================================================================
// VECTOR - QUERY WORDS IN A CHUNK'S TEXT (pure)
// =============================================================================
//
// The chunk text panel marks the words of the active query in a chunk's full
// text. Matching is lexical and deliberately light: case-insensitive, whole
// words, a small suffix strip so "water", "waters" and "watering" meet, and
// the common English function words left out. Retrieval itself is by meaning,
// and the panel says so; these marks only help the eye.
//
// The answer is a list of text segments that joins back to the text exactly.
// Nothing here builds markup: the panel renders each marked segment as a
// <mark> element whose child is the segment's text, so a chunk holding '<b>'
// or '&amp;' shows those characters.
//
// Words are scanned character by character (letters of any script, digits,
// and an apostrophe between letters) rather than with Unicode property
// regexes or Intl.Segmenter, which some of the browsers this app supports
// lack. Letters without case (Arabic, Hebrew, the Indic scripts, Hangul,
// Ethiopic, Tibetan) are known by their blocks and match as whole words.
// Scripts written without spaces between words (Chinese, Japanese, Thai,
// Lao, Khmer, Myanmar) have no word ends to find, so there a query word is
// marked wherever it occurs inside a run, and one character is a word.
// =============================================================================

/** Most characters of a chunk the panel shows. */
export const CHUNK_TEXT_MAX = 20000;

/** One run of text: a query word (mark) or anything between them. */
export interface ITextSegment {
	text: string;
	mark: boolean;
}

/** Common English function words: never marked. */
export const STOP_WORDS: ReadonlySet<string> = new Set(('a about above after again against all also am an and any are as at be because been before being below between both but by ' + 'can could did do does doing done down during each few for from further get gets got had has have having he her here hers ' + 'herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or ' + 'other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there ' + 'these they this those through to too under until up us very was we were what when where which while who whom whose why will ' + 'with would you your yours yourself yourselves shall may might must let lets').split(' '));

/**
 * Whether a UTF-16 unit is a letter of a script written without spaces
 * between words: Thai, Lao, Myanmar, Khmer, kana, CJK ideographs.
 *
 * @param code - The unit.
 * @returns True for those scripts.
 */
function isUnspaced(code: number): boolean {
	return (code >= 0x0e00 && code <= 0x0eff) || (code >= 0x1000 && code <= 0x109f) || (code >= 0x1780 && code <= 0x17ff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

/**
 * Whether a UTF-16 unit is a letter (or a combining mark) of a script
 * without case that spaces its words: Hebrew, Arabic, Syriac, Thaana, the
 * Indic scripts, Tibetan, Ethiopic, Hangul.
 *
 * @param code - The unit.
 * @returns True for those scripts.
 */
function isCaselessSpaced(code: number): boolean {
	if (CASELESS_PUNCTUATION.has(code)) return false;
	return (code >= 0x0591 && code <= 0x05f4) || (code >= 0x0610 && code <= 0x06ff) || (code >= 0x0700 && code <= 0x07bf) || (code >= 0x08a0 && code <= 0x08ff) || (code >= 0x0900 && code <= 0x0dff) || (code >= 0x0f00 && code <= 0x0fff) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x1200 && code <= 0x137f) || (code >= 0x3130 && code <= 0x318f) || (code >= 0xac00 && code <= 0xd7af);
}

/** Punctuation inside those blocks (Hebrew maqaf and sof pasuq, Arabic comma to full stop, the Indic dandas, Ethiopic stops): never part of a word. */
const CASELESS_PUNCTUATION: ReadonlySet<number> = new Set([0x05be, 0x05c0, 0x05c3, 0x05c6, 0x061b, 0x061e, 0x061f, 0x066a, 0x066b, 0x066c, 0x066d, 0x06d4, 0x0964, 0x0965, 0x0f0b, 0x0f0d, 0x0f0e, 0x1361, 0x1362, 0x1363, 0x1364, 0x1365, 0x1366, 0x1367, 0x1368]);

/**
 * What a character is to the word scan: 0 not a word character, 1 a letter
 * or digit of a spaced script, 2 a letter of a script without spaces.
 *
 * @param ch - One character (one UTF-16 unit).
 * @returns Its kind.
 */
function kindOf(ch: string): 0 | 1 | 2 {
	if (ch >= '0' && ch <= '9') return 1;
	const code = ch.charCodeAt(0);
	if (isUnspaced(code)) return 2;
	if (isCaselessSpaced(code)) return 1;
	return ch.toLowerCase() !== ch.toUpperCase() ? 1 : 0;
}

/** Apostrophes that may join two parts of a word ("station's"). */
const APOSTROPHES = "'’";

/** A run of the scan: a word of a spaced script, a run of an unspaced script, or anything between. */
interface IRun {
	text: string;
	word: boolean;
	/** A run of a script without spaces (a query word may sit inside it). */
	unspaced: boolean;
}

/**
 * Split text into word and non-word runs; a run of an unspaced script is
 * its own run.
 *
 * @param text - Any text.
 * @returns The runs, in order; they join back to `text`.
 */
function runs(text: string): IRun[] {
	const out: IRun[] = [];
	let i = 0;
	while (i < text.length) {
		const start = i;
		const kind = kindOf(text[i] as string);
		i += 1;
		while (i < text.length) {
			const ch = text[i] as string;
			const next = kindOf(ch);
			if (kind === 1) {
				if (next === 1) i += 1;
				else if (APOSTROPHES.includes(ch) && i + 1 < text.length && kindOf(text[i + 1] as string) === 1) i += 2;
				else break;
			} else if (next !== kind) break;
			else i += 1;
		}
		out.push({ text: text.slice(start, i), word: kind !== 0, unspaced: kind === 2 });
	}
	return out;
}

/**
 * The fewest characters a query word needs: one for a Hangul syllable block
 * (a whole syllable, often a word: 물), two otherwise (one Latin letter is no
 * word worth marking).
 *
 * @param word - The word.
 * @returns 1 or 2.
 */
function shortestWord(word: string): number {
	const code = word.charCodeAt(0);
	return word.length === 1 && code >= 0xac00 && code <= 0xd7af ? 1 : 2;
}

/**
 * Drop one letter of a doubled final consonant ("runn" → "run"); l, s and z stay doubled.
 *
 * @param word - A word with a suffix removed.
 * @returns The word.
 */
function undouble(word: string): string {
	const last = word[word.length - 1];
	if (word.length > 2 && last === word[word.length - 2] && last !== undefined && !'aeiouylsz'.includes(last)) return word.slice(0, -1);
	return word;
}

/**
 * The light stem of a word: lower-cased, a possessive dropped, then one of
 * -ies, -ing, -ed, -es (after s, x, z, ch, sh) or a plural -s removed, and a
 * final e dropped, each only on words long enough for it to be a suffix.
 *
 * @param word - One word.
 * @returns Its stem.
 */
export function stem(word: string): string {
	let w = word.toLowerCase();
	if (w.length > 2 && (w.endsWith("'s") || w.endsWith('’s'))) w = w.slice(0, -2);
	if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
	else if (w.length > 5 && w.endsWith('ing')) w = undouble(w.slice(0, -3));
	else if (w.length > 4 && w.endsWith('ed')) w = undouble(w.slice(0, -2));
	else if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
	if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
	return w;
}

/**
 * The words of a query that the panel marks: stop-words and one-letter words
 * left out, each stem once, in the order they first appear.
 *
 * @param query - The active query, or null.
 * @returns The stems.
 */
export function queryTerms(query: string | null | undefined): string[] {
	if (!query) return [];
	const out: string[] = [];
	for (const run of runs(query)) {
		if (!run.word) continue;
		if (run.unspaced) {
			if (!out.includes(run.text)) out.push(run.text);
			continue;
		}
		const lower = run.text.toLowerCase();
		const bare = lower.replace(/['’]s$/, '');
		if (bare.length < shortestWord(bare) || STOP_WORDS.has(lower) || STOP_WORDS.has(bare)) continue;
		const s = stem(lower);
		if (s.length >= shortestWord(s) && !out.includes(s)) out.push(s);
	}
	return out;
}

/**
 * The query's words as typed (lower-cased), one per stem, in the order they
 * first appear: what the panel names when it counts the marks.
 *
 * @param query - The active query, or null.
 * @returns The words.
 */
export function queryWords(query: string | null | undefined): string[] {
	if (!query) return [];
	const stems = new Set<string>();
	const out: string[] = [];
	for (const run of runs(query)) {
		if (!run.word) continue;
		if (run.unspaced) {
			if (!stems.has(run.text)) {
				stems.add(run.text);
				out.push(run.text);
			}
			continue;
		}
		const lower = run.text.toLowerCase();
		const bare = lower.replace(/['’]s$/, '');
		if (bare.length < shortestWord(bare) || STOP_WORDS.has(lower) || STOP_WORDS.has(bare)) continue;
		const s = stem(lower);
		if (s.length < shortestWord(s) || stems.has(s)) continue;
		stems.add(s);
		out.push(bare);
	}
	return out;
}

/**
 * Split a chunk's text into segments, marking every whole word whose stem is
 * one of the query's and, in a run of a script without spaces, every place a
 * query word of that script occurs (the longest first). Unmarked runs are
 * merged; the segments join back to the text exactly.
 *
 * @param text - The chunk's text.
 * @param query - The active query, or null.
 * @returns The segments (none for empty text).
 */
export function highlightSegments(text: string, query: string | null | undefined): ITextSegment[] {
	if (text === '') return [];
	const terms = new Set(queryTerms(query));
	if (terms.size === 0) return [{ text, mark: false }];
	const inside = [...terms].filter((t) => runs(t).every((r) => r.unspaced)).sort((a, b) => b.length - a.length);
	const out: ITextSegment[] = [];
	let plain = '';
	const mark = (word: string): void => {
		if (plain !== '') out.push({ text: plain, mark: false });
		plain = '';
		out.push({ text: word, mark: true });
	};
	for (const run of runs(text)) {
		if (run.unspaced && inside.length > 0) {
			let at = 0;
			while (at < run.text.length) {
				const found = inside.find((t) => run.text.startsWith(t, at));
				if (found) {
					mark(found);
					at += found.length;
				} else {
					plain += run.text[at] as string;
					at += 1;
				}
			}
		} else if (run.word && !run.unspaced && terms.has(stem(run.text))) mark(run.text);
		else plain += run.text;
	}
	if (plain !== '') out.push({ text: plain, mark: false });
	return out;
}

/**
 * How many words are marked.
 *
 * @param segments - The segments.
 * @returns The count.
 */
export function markedWords(segments: readonly ITextSegment[]): number {
	let n = 0;
	for (const s of segments) if (s.mark) n += 1;
	return n;
}

/**
 * Cut a chunk's text to what the panel shows, on a character boundary.
 *
 * @param text - The full text.
 * @param max - Most characters (CHUNK_TEXT_MAX).
 * @returns The text and whether it was cut.
 */
export function clampText(text: string, max: number = CHUNK_TEXT_MAX): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	// Never between the two halves of a character outside the BMP (an emoji, a rare ideograph).
	const last = text.charCodeAt(max - 1);
	const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
	return { text: text.slice(0, end), truncated: true };
}
