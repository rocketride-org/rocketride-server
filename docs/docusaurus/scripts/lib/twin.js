/**
 * Clean markdown for the LLM surface (the `.md` twins and llms-full.txt).
 *
 * Page sources carry front matter and, for `.mdx` pages, `import` lines and JSX
 * wrappers that mean nothing to an agent reading the raw file. This strips
 * them and keeps the text and the links. Fenced code, inline code and comments
 * are never touched, and `.md` pages (parsed as CommonMark, so `<name>` is
 * literal text) only lose their front matter. Anything this cannot parse with
 * confidence (an unclosed tag, an `export` that never balances) is left
 * exactly as written rather than guessed at.
 */

const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'col']);
const IMPORT_LINE = /^[ \t]*import\s+(?:['"]|\*|\{|[\w$]+\s*(?:,|from\b))/;
const EXPORT_LINE = /^[ \t]*export\s+(?:const|let|var|function|class|default|async|type|interface|\{|\*)/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const BLANK_LINE = /\n[ \t]*\n/;

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
 * Split text into fenced and unfenced segments. A fence closes only on the same
 * character with at least as many marks, so a four-backtick fence can hold a
 * three-backtick one. An unclosed fence runs to the end, as in CommonMark.
 */
function splitFences(text) {
	const segments = [];
	let buf = [];
	let fence = null;
	const flush = (isFence) => {
		if (buf.length) segments.push({ fence: isFence, text: buf.join('\n') });
		buf = [];
	};
	for (const line of text.split(/\r?\n/)) {
		if (!fence) {
			const open = fenceOpener(line);
			if (open) {
				flush(false);
				fence = open;
			}
			buf.push(line);
			continue;
		}
		buf.push(line);
		if (fenceCloses(line, fence)) {
			flush(true);
			fence = null;
		}
	}
	flush(!!fence);
	return segments;
}

/**
 * Index of the quote that closes the string opened at `j`, or -1. A backslash
 * skips the character after it. A `'` or `"` string cannot hold a line break, so
 * meeting one means the quote was plain text (`Don't`): only a template literal
 * spans lines.
 */
function stringEnd(src, j) {
	const q = src[j];
	for (let k = j + 1; k < src.length; k++) {
		if (src[k] === '\\') k++;
		else if (src[k] === q) return k;
		else if (src[k] === '\n' && q !== '`') return -1;
	}
	return -1;
}

/** Index after the `}` that closes the `{` at `j`, or -1. Strings are skipped. */
function skipBraces(src, j) {
	let depth = 0;
	for (; j < src.length; j++) {
		const c = src[j];
		if (c === '"' || c === "'" || c === '`') {
			const k = stringEnd(src, j);
			if (k < 0) return -1;
			j = k;
		} else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return j + 1;
	}
	return -1;
}

/**
 * Parse the JSX/HTML tag that starts at `i`. Quoted values and `{...}`
 * expressions may contain `>`. Returns null when it is not a well-formed tag.
 */
function parseTag(src, i) {
	let j = i + 1;
	const closing = src[j] === '/';
	if (closing) j++;
	const name = /^[A-Za-z][A-Za-z0-9._-]*/.exec(src.slice(j, j + 80));
	if (!name) return null;
	j += name[0].length;
	if (!/[\s/>]/.test(src[j] || '')) return null; // `<https://x>` is an autolink
	const attrsStart = j;
	for (; j < src.length; j++) {
		const c = src[j];
		if (c === '"' || c === "'") {
			const k = src.indexOf(c, j + 1);
			if (k < 0) return null;
			j = k;
		} else if (c === '{') {
			const k = skipBraces(src, j);
			if (k < 0) return null;
			j = k - 1;
		} else if (c === '>') {
			if (BLANK_LINE.test(src.slice(i, j))) return null;
			return {
				end: j + 1,
				name: name[0],
				closing,
				selfClosing: src[j - 1] === '/',
				attrs: src.slice(attrsStart, j),
			};
		}
	}
	return null;
}

function attr(attrs, name) {
	const quoted = `"([^"]*)"|'([^']*)'`;
	const braced = `\\{\\s*(?:"([^"\\\\]*)"|'([^'\\\\]*)')\\s*\\}`; // a plain string literal inside braces
	const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:${quoted}|${braced})`).exec(attrs);
	return m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : null;
}

/** End index (the newline or end of text) of the import/export statement at `i`, or -1. */
function statementEnd(src, i) {
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		const c = src[j];
		if (c === '"' || c === "'" || c === '`') {
			const k = stringEnd(src, j);
			if (k < 0) return -1;
			j = k;
		} else if ('({['.includes(c)) depth++;
		else if (')}]'.includes(c)) depth--;
		else if (c === '\n') {
			if (depth <= 0) return j;
			if (/^[ \t]*(\n|$)/.test(src.slice(j + 1, j + 200))) return -1; // a blank line: not one statement
		}
	}
	return depth <= 0 ? src.length : -1;
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

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Strips JSX and imports from one unfenced MDX segment. The fields are the
 * state the steps share: `out` (the text so far), `frame` (the open `<a href>`,
 * whose text becomes a markdown link), and the line bookkeeping that drops a
 * line made only of tags. `state.depth` carries the wrapper nesting across
 * fenced blocks, so it lives outside this class.
 */
class MdxCleaner {
	constructor(src, state) {
		this.src = src;
		this.state = state;
		this.i = 0;
		this.out = '';
		this.lineStart = 0; // index in `out` where the current line began
		this.lineHadTag = false;
		this.trimLead = state.depth > 0; // inside a wrapper, the wrapper's indentation would read as code
		this.frame = null;
	}

	run() {
		const { src } = this;
		while (this.i < src.length) {
			const c = src[this.i];
			if (this.skipStatement()) continue;
			if (c === '\n') this.newline();
			else if (this.trimLead && this.trimIndent()) continue;
			else if (c === '<' && src.startsWith('<!--', this.i)) this.copyLiteral('-->', 4);
			else if (c === '{' && src.startsWith('{/*', this.i)) this.copyLiteral('*/}', 3);
			else if (c === '`') this.copyCodeSpan();
			else if (c === '<' && /[A-Za-z/]/.test(src[this.i + 1] || '')) this.handleTag();
			else if (c === '&') this.decodeEntity();
			else {
				this.emit(c);
				this.i++;
			}
		}
		if (this.frame) this.closeFrame();
		return this.out;
	}

	emit(s) {
		const { frame } = this;
		if (!frame) this.out += s;
		else if (frame.titleLevel >= 0) frame.title += s;
		else frame.rest += s;
	}

	closeFrame() {
		const f = this.frame;
		this.frame = null;
		const title = collapse(f.title) || collapse(f.rest);
		if (!title) return;
		if (f.title.trim()) {
			const rest = collapse(f.rest);
			this.out += `- [${title}](${f.href})${rest ? `: ${rest}` : ''}`; // a card: title span plus body span
		} else this.out += `[${title}](${f.href})`;
	}

	/** Drop an import/export statement that starts at the current line. True when it did. */
	skipStatement() {
		const { src, i } = this;
		if (this.frame || !(i === 0 || src[i - 1] === '\n')) return false;
		const rest = src.slice(i, i + 200);
		if (!IMPORT_LINE.test(rest) && !EXPORT_LINE.test(rest)) return false;
		const end = statementEnd(src, i);
		if (end < 0) return false; // never balances: leave it as written
		this.i = end + 1;
		return true;
	}

	/** Handle the newline at the current position. */
	newline() {
		if (this.frame) this.emit(' ');
		// a line that was only tags disappears with its newline
		else if (this.lineHadTag && !this.out.slice(this.lineStart).trim()) {
			this.out = this.out.slice(0, this.lineStart);
		} else this.out += '\n';
		if (!this.frame) {
			this.lineStart = this.out.length;
			this.lineHadTag = false;
			this.trimLead = this.state.depth > 0;
		}
		this.i++;
	}

	/** Remove wrapper indentation at the start of a line. True when it consumed input. */
	trimIndent() {
		const { src, state } = this;
		this.trimLead = false;
		let n = 0;
		while (src[this.i + n] === ' ' || src[this.i + n] === '\t') n++;
		if (src[this.i + n] === '\n' || this.i + n >= src.length) {
			this.i += n; // a blank line
			return true;
		}
		// Remove only the indentation the wrapper added (that of the first line
		// at this nesting depth), so a nested list keeps its own indentation.
		if (state.base == null || state.baseDepth !== state.depth) {
			state.base = n;
			state.baseDepth = state.depth;
		}
		if (!n) return false;
		this.i += Math.min(n, state.base);
		return true;
	}

	/** Copy a comment through its closer (or to the end of the text when unclosed). */
	copyLiteral(closer, openLen) {
		const k = this.src.indexOf(closer, this.i + openLen);
		const end = k < 0 ? this.src.length : k + closer.length;
		this.emit(this.src.slice(this.i, end));
		this.i = end;
	}

	/** Copy a code span, or just its backtick run when it never closes. */
	copyCodeSpan() {
		const { src, i } = this;
		let end = codeSpanEnd(src, i);
		if (end < 0) {
			end = i;
			while (src[end] === '`') end++;
		}
		this.emit(src.slice(i, end));
		this.i = end;
	}

	handleTag() {
		const { src } = this;
		const t = parseTag(src, this.i);
		if (!t) {
			this.emit(src[this.i]);
			this.i++;
			return;
		}
		this.lineHadTag = true;
		this.i = t.end;
		const before = this.out.length;
		this.applyTag(t);
		if (!this.frame && t.selfClosing && this.out.length === before) this.tidyDroppedTag();
	}

	/** A dropped icon or image must not leave `** text**` or `()`. */
	tidyDroppedTag() {
		const { src } = this;
		if (/(\*\*|__)$/.test(this.out)) while (src[this.i] === ' ') this.i++;
		else if (/(\*\*|__)/.test(src.slice(this.i, this.i + 2)) && /[ \t]$/.test(this.out)) {
			this.out = this.out.replace(/[ \t]+$/, '');
		}
		if (this.out.endsWith('(') && src[this.i] === ')') {
			this.out = this.out.slice(0, -1);
			this.i++;
		}
	}

	applyTag(t) {
		const { name } = t;
		if (name.toLowerCase() === 'br' && !t.closing) this.emit(' '); // a line break stays a separator
		if (name === 'a') this.applyAnchor(t);
		else if (this.frame) this.trackSpan(t);
		else this.applyBlockTag(t);
	}

	applyAnchor(t) {
		if (t.closing) {
			if (this.frame) this.closeFrame();
			return;
		}
		const href = attr(t.attrs, 'href');
		if (!this.frame && !t.selfClosing && href) this.frame = { href, title: '', rest: '', spans: 0, titleLevel: -1 };
	}

	/** Inside a link: note the title span, so a card's title and body can be told apart. */
	trackSpan(t) {
		const { frame } = this;
		if (t.name !== 'span' || t.selfClosing) return;
		if (t.closing) {
			if (frame.titleLevel === frame.spans) frame.titleLevel = -1;
			frame.spans = Math.max(0, frame.spans - 1);
		} else {
			frame.spans++;
			if (frame.titleLevel < 0 && /\bclass(?:Name)?\s*=\s*"[^"]*title/.test(t.attrs)) frame.titleLevel = frame.spans;
		}
	}

	applyBlockTag(t) {
		const { name } = t;
		if (name === 'Card' && !t.closing) {
			const href = attr(t.attrs, 'href');
			const title = attr(t.attrs, 'title');
			if (href && title) this.out += `- [${title}](${href})`; // <Card> carries its text in `title`
		}
		if (t.closing) this.state.depth = Math.max(0, this.state.depth - 1);
		else if (!t.selfClosing && !VOID_TAGS.has(name.toLowerCase())) this.state.depth++;
	}

	decodeEntity() {
		const { src, i } = this;
		const m = /^&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d+)|#x([0-9a-fA-F]+));/.exec(src.slice(i, i + 12));
		if (!m) {
			this.emit('&');
			this.i++;
			return;
		}
		const code = m[2] ? +m[2] : m[3] ? parseInt(m[3], 16) : null;
		this.emit(m[1] ? ENTITIES[m[1]] : code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m[0]);
		this.i += m[0].length;
	}
}

/**
 * Strip JSX and imports from unfenced MDX text. `state.depth` carries the
 * wrapper nesting across fenced blocks.
 */
function cleanMdx(src, state) {
	return new MdxCleaner(src, state).run();
}

/** Extract a `title:` from a leading YAML front-matter block, if present. */
function frontMatterTitle(content) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!m) return null;
	const t = /(^|\n)title:\s*(.+?)\s*(\n|$)/.exec(m[1]);
	return t ? t[2].replace(/^['"]|['"]$/g, '') : null;
}

/**
 * @param {string} raw - page source (md/mdx), generated or authored.
 * @param {object} [opts]
 * @param {boolean} [opts.mdx] - the source is MDX: drop imports and JSX tags.
 * @param {string} [opts.indexUrl] - when set, add a one-line pointer to the docs index.
 * @param {boolean} [opts.addTitle] - add the front matter title as `# Title` when the body has none (default true).
 * @return {string} clean markdown.
 */
function cleanTwin(raw, { mdx = false, indexUrl = '', addTitle = true } = {}) {
	const fm = FRONT_MATTER.exec(raw);
	const title = fm ? frontMatterTitle(raw) : null;
	const segments = splitFences(fm ? raw.slice(fm[0].length) : raw);
	const state = { depth: 0, base: null, baseDepth: 0 };
	const parts = segments.map((s) => (mdx && !s.fence ? cleanMdx(s.text, state) : s.text));
	// Collapse blank-line runs only outside code fences, where blank lines are part of the code.
	const fenced = [];
	let joined = '';
	parts.forEach((part, i) => {
		if (i) joined += '\n';
		if (segments[i].fence) fenced.push([joined.length, joined.length + part.length]);
		joined += part;
	});
	let body = joined.replace(/\n{3,}/g, (run, at) => (fenced.some(([a, b]) => at >= a && at < b) ? run : '\n\n')).trim();
	// A `# comment` inside a code fence is not a title.
	const hasTitle = segments.some((s, i) => !s.fence && /^# /m.test(parts[i]));
	if (addTitle && title && !hasTitle) body = `# ${title}\n\n${body}`;
	return `${indexUrl ? `${INDEX_LINE_PREFIX}: ${indexUrl}\n\n` : ''}${body}\n`;
}

// First line of every published .md twin; llms.js uses it to spot an already-rewritten file.
const INDEX_LINE_PREFIX = '> Documentation index for agents';

module.exports = { cleanTwin, splitFences, fenceOpener, fenceCloses, codeSpanEnd, frontMatterTitle, INDEX_LINE_PREFIX };
