/**
 * Shared markdown scanners: the fence, code-span and front-matter readers used
 * by the twin writer (twin.js) and the description builder (description.js).
 */

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * The fence a line opens, as `{ ch, len }`, or null. This is the one fence rule
 * for the twins and the meta descriptions. A backtick fence cannot carry a
 * backtick in its info string (that line is an inline code span, not a fence).
 */
function fenceOpener(line) {
	const m = FENCE_OPEN.exec(line.replace(/\r$/, ''));
	return m && !(m[1][0] === '`' && m[2].includes('`')) ? { ch: m[1][0], len: m[1].length } : null;
}

/** Whether `line` closes `fence`: the same character, at least as many marks, and nothing after them. */
function fenceCloses(line, fence) {
	const m = FENCE_OPEN.exec(line.replace(/\r$/, ''));
	return !!m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim();
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

module.exports = { fenceOpener, fenceCloses, codeSpanEnd, codeSpanStop, frontMatterTitle };
