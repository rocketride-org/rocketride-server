/**
 * Meta description for a docs page, taken from the page's own first paragraph.
 *
 * Docusaurus' default is the first source line of the first paragraph, so a
 * hard-wrapped paragraph is cut mid-sentence, and a page that opens with an
 * HTML comment gets the comment as its description. This joins the paragraph
 * across line wraps, strips markup, and keeps whole sentences up to the limit.
 * Text inside inline code is kept as written, so `<your-api-key>` survives.
 */

const { fenceOpener, fenceCloses, codeSpanEnd } = require('./twin');

const MAX = 160;
const SKIP_LINE = /^(#{1,6}\s|:::|\||[<{]|import\s|export\s|-{3,}|[-*+]\s|\d+[.)]\s|>|!\[)/;
const CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
// A period after these does not end a sentence, even when a capital letter follows.
const SENTENCE_END = /(?<!\b(?:[Ee]\.g|[Ii]\.e|etc|vs|cf)\.)(?<=[.!?])\s+(?=[A-Z0-9"([])/;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * End index of the fenced block that opens on the line at `i`, copied up to its
 * closing line (or the end of the text); -1 when no fence opens there.
 */
function fenceBlockEnd(text, i) {
	const nl = text.indexOf('\n', i);
	const open = fenceOpener(text.slice(i, nl < 0 ? text.length : nl));
	if (!open) return -1;
	let stop = nl < 0 ? text.length : nl + 1;
	while (stop < text.length) {
		const next = text.indexOf('\n', stop);
		const line = text.slice(stop, next < 0 ? text.length : next);
		stop = next < 0 ? text.length : next + 1;
		if (fenceCloses(line, open)) break;
	}
	return stop;
}

/** End index of the HTML comment that starts at `i`, or -1 when there is none or it never closes. */
function commentEnd(text, i) {
	if (!text.startsWith('<!--', i)) return -1;
	const end = text.indexOf('-->', i + 4);
	return end < 0 ? -1 : end + 3;
}

/** End index of the code span at `i`; an unclosed backtick run is just the run itself. */
function codeSpanStop(text, i) {
	const end = codeSpanEnd(text, i);
	if (end >= 0) return end;
	let run = i;
	while (text[run] === '`') run++;
	return run;
}

/**
 * Remove HTML comments from page text, but not from fenced code blocks or inline
 * code, where `<!--` is literal text and must not swallow what follows it.
 *
 * One pass, so the three constructs cannot confuse each other: a fence marker
 * inside a comment does not open a fence, a comment opener inside code is kept,
 * and an escaped backtick does not open a code span.
 */
function stripComments(text) {
	let out = '';
	let i = 0;
	let lineStart = true;
	while (i < text.length) {
		const fenceEnd = lineStart ? fenceBlockEnd(text, i) : -1;
		if (fenceEnd >= 0) {
			out += text.slice(i, fenceEnd);
			i = fenceEnd;
			continue;
		}
		const ch = text[i];
		lineStart = false;
		const stop = ch === '\\' ? Math.min(i + 2, text.length) : ch === '`' ? codeSpanStop(text, i) : -1;
		if (stop >= 0) {
			out += text.slice(i, stop);
			i = stop;
			continue;
		}
		const skipTo = commentEnd(text, i);
		if (skipTo >= 0) {
			i = skipTo;
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
	let fence = null; // the open code fence
	let inStatement = false; // an MDX import/export runs to the next blank line, as in Docusaurus createExcerpt
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (fence) {
			if (fenceCloses(line, fence)) fence = null;
			continue;
		}
		const open = fenceOpener(line);
		if (open) {
			if (para.length) break;
			fence = open;
			continue;
		}
		if (!t) inStatement = false;
		else if (/^(import|export)\s/.test(t)) inStatement = true;
		if (!t || inStatement || SKIP_LINE.test(t)) {
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
