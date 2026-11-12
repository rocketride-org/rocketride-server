/**
 * Meta description for a docs page, taken from the page's own first paragraph.
 *
 * Docusaurus' default is the first source line of the first paragraph, so a
 * hard-wrapped paragraph is cut mid-sentence, and a page that opens with an
 * HTML comment gets the comment as its description. This joins the paragraph
 * across line wraps, strips markup, and keeps whole sentences up to the limit.
 * Text inside inline code is kept as written, so `<your-api-key>` survives.
 */

const MAX = 160;
const SKIP_LINE = /^(#{1,6}\s|:::|\||[<{]|import\s|export\s|-{3,}|[-*+]\s|\d+[.)]\s|>|!\[)/;
const CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
// A period after these does not end a sentence, even when a capital letter follows.
const SENTENCE_END = /(?<!\b(?:[Ee]\.g|[Ii]\.e|etc|vs|cf)\.)(?<=[.!?])\s+(?=[A-Z0-9"([])/;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * Remove HTML comments from page text, but not from fenced code blocks or inline
 * code, where `<!--` is literal text and must not swallow what follows it.
 *
 * One pass, so the three constructs cannot confuse each other: a fence marker
 * inside a comment does not open a fence, a comment opener inside code is kept,
 * and an escaped backtick does not open a code span.
 */
function stripComments(text) {
	const fenceOpen = /^ {0,3}(`{3,}|~{3,})([^\n]*)/;
	let out = '';
	let i = 0;
	let lineStart = true;
	while (i < text.length) {
		if (lineStart) {
			const end = text.indexOf('\n', i);
			const line = text.slice(i, end < 0 ? text.length : end);
			const open = fenceOpen.exec(line);
			if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
				// Copy the whole fenced block, up to its closing line or the end of the text.
				const close = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*\\r?$`);
				let stop = end < 0 ? text.length : end + 1;
				while (stop < text.length) {
					const next = text.indexOf('\n', stop);
					const nextLine = text.slice(stop, next < 0 ? text.length : next);
					stop = next < 0 ? text.length : next + 1;
					if (close.test(nextLine)) break;
				}
				out += text.slice(i, stop);
				i = stop;
				continue;
			}
		}
		const ch = text[i];
		if (ch === '\\' && i + 1 < text.length) {
			out += text.slice(i, i + 2);
			i += 2;
			lineStart = false;
			continue;
		}
		if (text.startsWith('<!--', i)) {
			const end = text.indexOf('-->', i + 4);
			if (end >= 0) {
				i = end + 3;
				lineStart = false;
				continue;
			}
		}
		if (ch === '`') {
			let run = 1;
			while (text[i + run] === '`') run++;
			// A code span ends at the next run of exactly the same number of backticks,
			// and cannot cross a block boundary: a blank line ends the search, and so
			// does the end of an ATX heading line.
			let from = i + run;
			let limit = text.length;
			const blank = /\n[ \t\r]*(?:\n|$)/g;
			blank.lastIndex = from;
			const gap = blank.exec(text);
			if (gap) limit = gap.index;
			const lineBegin = text.lastIndexOf('\n', i - 1) + 1;
			if (/^ {0,3}#{1,6}[ \t]/.test(text.slice(lineBegin, i))) {
				const eol = text.indexOf('\n', from);
				if (eol >= 0 && eol < limit) limit = eol;
			}
			let close = -1;
			while (from < limit) {
				const at = text.indexOf('`', from);
				if (at < 0 || at >= limit) break;
				let len = 1;
				while (text[at + len] === '`') len++;
				if (len === run) {
					close = at;
					break;
				}
				from = at + len;
			}
			const stop = close < 0 ? i + run : close + run;
			out += text.slice(i, stop);
			i = stop;
			lineStart = false;
			continue;
		}
		out += ch;
		lineStart = ch === '\n';
		i++;
	}
	return out;
}

/** The first prose paragraph of a page body, as raw lines joined by spaces ('' if none). */
function firstParagraph(body) {
	const text = stripComments(body).replace(/<head>[\s\S]*?<\/head>/gi, '');
	const para = [];
	let fence = null; // the open code fence: it closes on the same character, at least as long
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (fence) {
			const close = /^(`{3,}|~{3,})$/.exec(t);
			if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
			continue;
		}
		const open = /^(`{3,}|~{3,})/.exec(t);
		if (open) {
			if (para.length) break;
			fence = { ch: open[1][0], len: open[1].length };
			continue;
		}
		if (!t || SKIP_LINE.test(t)) {
			if (para.length) break;
			continue;
		}
		para.push(t);
	}
	return para.join(' ');
}

/** Remove markdown and HTML markup from a paragraph. Inline code keeps its text. */
function stripMarkup(raw) {
	const spans = [];
	const text = raw
		.replace(CODE_SPAN, (m, ticks, inner) => `\uE000${spans.push(inner.replace(/^ (.*) $/, '$1')) - 1}\uE001`)
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<\/?[A-Za-z][^<>]*>/g, '')
		.replace(/[*]|\b_|_\b/g, '')
		.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (e) => ENTITIES[e])
		.replace(/\s+/g, ' ')
		.trim();
	return text.replace(/\uE000(\d+)\uE001/g, (m, n) => spans[n]);
}

/**
 * @param {string} paragraph - the lines of one paragraph, joined by spaces, markup still in.
 * @return {string} a description of at most 160 characters, or '' when there is no prose.
 */
function describeText(paragraph) {
	// A paragraph that introduces a list ends in a colon; end the sentence instead.
	const prose = stripMarkup(paragraph).replace(/:$/, '.');
	if (prose.length <= MAX) return prose;
	// Whole sentences first.
	let out = '';
	for (const s of prose.split(SENTENCE_END)) {
		const next = out ? `${out} ${s}` : s;
		if (next.length > MAX) break;
		out = next;
	}
	if (out) return out;
	// The first sentence alone is too long. A semicolon or dash usually ends an
	// independent clause, so cut there; otherwise cut at a word boundary.
	const head = prose.slice(0, MAX);
	const clause = Math.max(head.lastIndexOf('; '), head.lastIndexOf(' \u2014 '));
	if (clause >= 60) return `${head.slice(0, clause).replace(/[\s,:]+$/, '')}.`;
	const cut = prose.slice(0, MAX - 1).replace(/\s+\S*$/, '').replace(/[\s,;:(-]+$/, '');
	return `${cut}…`;
}

/**
 * @param {string} body - page content without front matter.
 * @return {string} a description of at most 160 characters, or '' when the page has no prose.
 */
function describePage(body) {
	return describeText(firstParagraph(body));
}

module.exports = { describePage, describeText, firstParagraph };
