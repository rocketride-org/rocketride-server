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

/** The first prose paragraph of a page body, as raw lines joined by spaces ('' if none). */
function firstParagraph(body) {
	const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<head>[\s\S]*?<\/head>/gi, '');
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

module.exports = { describePage, describeText };
