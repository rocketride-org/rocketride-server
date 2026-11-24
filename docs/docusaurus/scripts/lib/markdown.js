/**
 * Shared markdown scanners: the fence, code-span and front-matter readers used
 * by the twin writer (twin.js) and the description builder (description.js).
 */

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
// ASCII punctuation: the characters a backslash escapes in CommonMark.
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/**
 * The blockquote markers that start `line`, at most `max` of them: how many
 * there are and where the text after them begins. A marker is up to three
 * spaces, `>`, and one optional space. A plain loop, so nothing backtracks.
 */
function quotePrefix(line, max = Infinity) {
	let depth = 0;
	let at = 0;
	while (depth < max) {
		let j = at;
		while (j - at < 3 && line[j] === ' ') j++;
		if (line[j] !== '>') break;
		j++;
		if (line[j] === ' ') j++;
		depth++;
		at = j;
	}
	return { depth, at };
}

/** Width in columns of a fence marker's indentation; a tab runs to the next multiple of four. */
function indentWidth(ws) {
	let col = 0;
	for (const c of ws) col = c === '\t' ? col + 4 - (col % 4) : col + 1;
	return col;
}

/**
 * The fence a line opens, as `{ ch, len, indent, quote }`, or null. This is the
 * one fence rule for the twins and the meta descriptions. A backtick fence cannot
 * carry a backtick in its info string (that line is an inline code span, not a
 * fence). A fence may sit inside a blockquote (`> ~~~jsx`): `quote` counts the
 * `>` markers before it, and `indent` is the marker's indentation after them.
 */
function fenceOpener(line) {
	const text = line.replace(/\r$/, '');
	const { depth, at } = quotePrefix(text);
	const m = FENCE_OPEN.exec(text.slice(at));
	if (!m || (m[2][0] === '`' && m[3].includes('`'))) return null;
	return { ch: m[2][0], len: m[2].length, indent: indentWidth(m[1]), quote: depth };
}

/**
 * Whether `line` closes `fence`: the same character, at least as many marks, and
 * nothing after them, in the fence's blockquote. The marker may sit at most three
 * columns deeper than the opener's (CommonMark allows three spaces; a deeper
 * marker is code). Measuring from the opener keeps a fence nested in a list
 * item closable. A line that leaves the fence's blockquote ends the fence too.
 */
function fenceCloses(line, fence) {
	const text = line.replace(/\r$/, '');
	const quote = fence.quote || 0;
	const { depth, at } = quotePrefix(text, quote);
	if (depth < quote) return true; // the blockquote ended, and the fence with it
	const m = FENCE_OPEN.exec(text.slice(at));
	return (
		!!m &&
		m[2][0] === fence.ch &&
		m[2].length >= fence.len &&
		!m[3].trim() &&
		indentWidth(m[1]) <= (fence.indent || 0) + 3
	);
}

/**
 * Where a code span opened at `from` (after its backtick run) must stop looking
 * for a closer: a blank line ends it, and so does the end of an ATX heading line.
 */
function codeSpanLimit(src, i, from) {
	let limit = src.length;
	const blank = /\n[ \t\r]*(?:\n|$)/g;
	blank.lastIndex = from;
	const gap = blank.exec(src);
	if (gap) limit = gap.index;
	const lineBegin = src.lastIndexOf('\n', i - 1) + 1;
	if (/^ {0,3}#{1,6}[ \t]/.test(src.slice(lineBegin, i))) {
		const eol = src.indexOf('\n', from);
		if (eol >= 0 && eol < limit) limit = eol;
	}
	return limit;
}

/**
 * End index of the code span opened by the backtick run at `i`, or -1. The span
 * ends at the next run of exactly the same length, and cannot cross a block
 * boundary (see codeSpanLimit).
 */
function codeSpanEnd(src, i) {
	let len = 0;
	while (src[i + len] === '`') len++;
	const limit = codeSpanLimit(src, i, i + len);
	let from = i + len;
	while (from < limit) {
		const at = src.indexOf('`', from);
		if (at < 0 || at >= limit) break;
		let run = 1;
		while (src[at + run] === '`') run++;
		if (run === len) return at + run;
		from = at + run;
	}
	return -1;
}

/** End index of the code span at `i`; an unclosed backtick run is just the run itself. */
function codeSpanStop(src, i) {
	const end = codeSpanEnd(src, i);
	if (end >= 0) return end;
	let run = i;
	while (src[run] === '`') run++;
	return run;
}

/** Extract a `title:` from a leading YAML front-matter block, if present. */
function frontMatterTitle(content) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!m) return null;
	const t = /(^|\n)title:\s*(.+?)\s*(\n|$)/.exec(m[1]);
	return t ? t[2].replace(/^['"]|['"]$/g, '') : null;
}

module.exports = { fenceOpener, fenceCloses, codeSpanEnd, codeSpanStop, frontMatterTitle, ESCAPABLE };
