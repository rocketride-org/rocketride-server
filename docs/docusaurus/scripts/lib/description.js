/**
 * Meta description for a docs page, taken from the page's own first paragraph.
 *
 * Docusaurus' default is the first source line of the first paragraph, so a
 * hard-wrapped paragraph is cut mid-sentence, and a page that opens with an
 * HTML comment gets the comment as its description. This joins the paragraph
 * across line wraps, strips markup, and keeps whole sentences up to the limit.
 * Text inside inline code is kept as written, so `<your-api-key>` survives.
 */

const { fenceOpener, fenceCloses, codeSpanEnd, codeSpanStop, ESCAPABLE } = require('./markdown');

const MAX = 160;
const SKIP_LINE = /^(#{1,6}\s|:::|\||[<{]|-{3,}|[-*+]\s|\d+[.)]\s|>|!\[)/;
const TAG_LINE = /^<\/?[A-Za-z]/;
const ESM_LINE = /^(import|export)\s/;
// A period after these does not end a sentence, even when a capital letter follows.
const SENTENCE_END = /(?<!\b(?:[Ee]\.g|[Ii]\.e|etc|vs|cf)\.)(?<=[.!?])\s+(?=[A-Z0-9"([])/;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Index of the newline that ends the line at `i`, or the end of the text. */
function lineEnd(text, i) {
	const nl = text.indexOf('\n', i);
	return nl < 0 ? text.length : nl;
}

/**
 * End index of the fenced block that opens on the line at `i`, copied up to its
 * closing line (or the end of the text); -1 when no fence opens there.
 */
function fenceBlockEnd(text, i) {
	const open = fenceOpener(text.slice(i, lineEnd(text, i)));
	if (!open) return -1;
	let stop = Math.min(lineEnd(text, i) + 1, text.length);
	while (stop < text.length) {
		const end = lineEnd(text, stop);
		const line = text.slice(stop, end);
		stop = Math.min(end + 1, text.length);
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
		let stop = -1;
		if (ch === '\\') stop = Math.min(i + 2, text.length);
		else if (ch === '`') stop = codeSpanStop(text, i);
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

/**
 * Whether the JSX/HTML tag being read ends on `line`, scanning from `from`. `tag`
 * carries the open quote and the `{...}` depth across lines, so a `>` inside a
 * quoted value or an expression does not end the tag. A plain loop, so nothing
 * backtracks.
 */
function tagEnds(line, from, tag) {
	for (let k = from; k < line.length; k++) {
		const c = line[k];
		if (tag.quote) {
			if (c === tag.quote) tag.quote = null;
		} else if (c === '"' || c === "'" || c === '`') tag.quote = c;
		else if (c === '{') tag.depth++;
		else if (c === '}') tag.depth--;
		else if (c === '>' && tag.depth <= 0) return true;
	}
	return false;
}

/** The first prose paragraph of a page body, as raw lines joined by spaces ('' if none). */
function firstParagraph(body) {
	const text = stripComments(body).replace(/<head>[\s\S]*?<\/head>/gi, '');
	const para = [];
	let fence = null; // the open code fence
	let tag = null; // a JSX/HTML tag whose attributes run onto later lines
	let inStatement = false; // an MDX import/export runs to the next blank line, as in Docusaurus createExcerpt
	let prevBlank = true; // import/export is ESM only at the start of a block
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		const blockStart = prevBlank;
		prevBlank = !t;
		if (tag && !t) tag = null; // a tag cannot run past a blank line
		if (tag) {
			if (tagEnds(line, 0, tag)) tag = null;
			continue;
		}
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
		else if (blockStart && ESM_LINE.test(line)) inStatement = true;
		if (!t || inStatement || SKIP_LINE.test(t)) {
			if (para.length) break;
			// A tag that does not close on its first line is skipped up to its `>`.
			if (TAG_LINE.test(t)) {
				const open = { quote: null, depth: 0 };
				if (!tagEnds(t, 1, open)) tag = open;
			}
			continue;
		}
		para.push(t);
	}
	return para.join(' ');
}

/** Remove markdown and HTML markup from a paragraph. Inline code keeps its text. */
function stripMarkup(raw) {
	const kept = [];
	const hold = (s) => `\uE000${kept.push(s) - 1}\uE001`;
	let protectedText = '';
	for (let i = 0; i < raw.length; ) {
		const ch = raw[i];
		if (ch === '\\' && ESCAPABLE.test(raw[i + 1] || '')) {
			protectedText += hold(raw[i + 1]); // an escaped character is literal, without its backslash
			i += 2;
		} else if (ch === '`') {
			const end = codeSpanEnd(raw, i);
			if (end < 0) {
				const stop = codeSpanStop(raw, i);
				protectedText += raw.slice(i, stop);
				i = stop;
				continue;
			}
			let len = 0;
			while (raw[i + len] === '`') len++;
			protectedText += hold(raw.slice(i + len, end - len).replace(/^ (.*) $/, '$1'));
			i = end;
		} else {
			protectedText += ch;
			i++;
		}
	}
	const text = protectedText
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<\/?[A-Za-z][^<>]*>/g, '')
		.replace(/[*]|\b_|_\b/g, '')
		.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (e) => ENTITIES[e])
		.replace(/\s+/g, ' ')
		.trim();
	return text.replace(/\uE000(\d+)\uE001/g, (m, n) => kept[n]);
}

/**
 * Shorten one paragraph to a description of at most 160 characters.
 *
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
 * Build the meta description for a page from its first prose paragraph.
 *
 * @param {string} body - page content without front matter.
 * @return {string} a description of at most 160 characters, or '' when the page has no prose.
 */
function describePage(body) {
	return describeText(firstParagraph(body));
}

module.exports = { describePage, firstParagraph };
