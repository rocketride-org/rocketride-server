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
			const m = FENCE_OPEN.exec(line);
			if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
				flush(false);
				fence = { ch: m[1][0], len: m[1].length };
			}
			buf.push(line);
			continue;
		}
		buf.push(line);
		const m = FENCE_OPEN.exec(line);
		if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) {
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

/** End index of the code span opened by the backtick run at `i`, or -1. */
function codeSpanEnd(src, i) {
	let len = 0;
	while (src[i + len] === '`') len++;
	for (let k = i + len; k < src.length; k++) {
		if (src[k] !== '`') continue;
		let run = 0;
		while (src[k + run] === '`') run++;
		if (run === len) return BLANK_LINE.test(src.slice(i, k)) ? -1 : k + run;
		k += run - 1;
	}
	return -1;
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Strip JSX and imports from unfenced MDX text. `state.depth` carries the
 * wrapper nesting across fenced blocks.
 */
function cleanMdx(src, state) {
	let out = '';
	let i = 0;
	let lineStart = 0; // index in `out` where the current line began
	let lineHadTag = false;
	let trimLead = state.depth > 0; // inside a wrapper, the wrapper's indentation would read as code
	let frame = null; // the open `<a href>`: its text becomes a markdown link
	const emit = (s) => {
		if (!frame) out += s;
		else if (frame.titleLevel >= 0) frame.title += s;
		else frame.rest += s;
	};
	const closeFrame = () => {
		const f = frame;
		frame = null;
		const title = collapse(f.title) || collapse(f.rest);
		if (!title) return;
		if (f.title.trim()) {
			const rest = collapse(f.rest);
			out += `- [${title}](${f.href})${rest ? `: ${rest}` : ''}`; // a card: title span plus body span
		} else out += `[${title}](${f.href})`;
	};
	const tag = (t) => {
		const name = t.name;
		if (name.toLowerCase() === 'br' && !t.closing) emit(' '); // a line break stays a separator
		if (name === 'a') {
			if (t.closing) {
				if (frame) closeFrame();
				return;
			}
			const href = attr(t.attrs, 'href');
			if (!frame && !t.selfClosing && href) frame = { href, title: '', rest: '', spans: 0, titleLevel: -1 };
			return;
		}
		if (frame) {
			if (name !== 'span' || t.selfClosing) return;
			if (t.closing) {
				if (frame.titleLevel === frame.spans) frame.titleLevel = -1;
				frame.spans = Math.max(0, frame.spans - 1);
			} else {
				frame.spans++;
				if (frame.titleLevel < 0 && /\bclass(?:Name)?\s*=\s*"[^"]*title/.test(t.attrs)) frame.titleLevel = frame.spans;
			}
			return;
		}
		if (name === 'Card' && !t.closing) {
			const href = attr(t.attrs, 'href');
			const title = attr(t.attrs, 'title');
			if (href && title) out += `- [${title}](${href})`; // <Card> carries its text in `title`
		}
		if (t.closing) state.depth = Math.max(0, state.depth - 1);
		else if (!t.selfClosing && !VOID_TAGS.has(name.toLowerCase())) state.depth++;
	};

	while (i < src.length) {
		const c = src[i];
		const atLineStart = !frame && (i === 0 || src[i - 1] === '\n');
		if (atLineStart) {
			const rest = src.slice(i, i + 200);
			if (IMPORT_LINE.test(rest) || EXPORT_LINE.test(rest)) {
				const end = statementEnd(src, i);
				if (end >= 0) {
					i = end + 1;
					continue;
				}
				// never balances: leave it as written
			}
		}
		if (c === '\n') {
			if (frame) emit(' ');
			// a line that was only tags disappears with its newline
			else if (lineHadTag && !out.slice(lineStart).trim()) out = out.slice(0, lineStart);
			else out += '\n';
			if (!frame) {
				lineStart = out.length;
				lineHadTag = false;
				trimLead = state.depth > 0;
			}
			i++;
			continue;
		}
		if (trimLead) {
			trimLead = false;
			let n = 0;
			while (src[i + n] === ' ' || src[i + n] === '\t') n++;
			if (src[i + n] === '\n' || i + n >= src.length) {
				i += n; // a blank line
				continue;
			}
			// Remove only the indentation the wrapper added (that of the first line
			// at this nesting depth), so a nested list keeps its own indentation.
			if (state.base == null || state.baseDepth !== state.depth) {
				state.base = n;
				state.baseDepth = state.depth;
			}
			if (n) {
				i += Math.min(n, state.base);
				continue;
			}
		}
		if (c === '<' && src.startsWith('<!--', i)) {
			const k = src.indexOf('-->', i + 4);
			const end = k < 0 ? src.length : k + 3;
			emit(src.slice(i, end));
			i = end;
		} else if (c === '{' && src.startsWith('{/*', i)) {
			const k = src.indexOf('*/}', i + 3);
			const end = k < 0 ? src.length : k + 3;
			emit(src.slice(i, end));
			i = end;
		} else if (c === '`') {
			const end = codeSpanEnd(src, i);
			if (end < 0) {
				let len = 0;
				while (src[i + len] === '`') len++;
				emit(src.slice(i, i + len));
				i += len;
			} else {
				emit(src.slice(i, end));
				i = end;
			}
		} else if (c === '<' && /[A-Za-z/]/.test(src[i + 1] || '')) {
			const t = parseTag(src, i);
			if (t) {
				lineHadTag = true;
				i = t.end;
				const before = out.length;
				tag(t);
				if (!frame && t.selfClosing && out.length === before) {
					// A dropped icon or image must not leave `** text**` or `()`.
					if (/(\*\*|__)$/.test(out)) while (src[i] === ' ') i++;
					else if (/(\*\*|__)/.test(src.slice(i, i + 2)) && /[ \t]$/.test(out)) out = out.replace(/[ \t]+$/, '');
					if (out.endsWith('(') && src[i] === ')') {
						out = out.slice(0, -1);
						i++;
					}
				}
			} else {
				emit(c);
				i++;
			}
		} else if (c === '&') {
			const m = /^&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d+)|#x([0-9a-fA-F]+));/.exec(src.slice(i, i + 12));
			if (m) {
				const code = m[2] ? +m[2] : m[3] ? parseInt(m[3], 16) : null;
				emit(m[1] ? ENTITIES[m[1]] : code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m[0]);
				i += m[0].length;
			} else {
				emit(c);
				i++;
			}
		} else {
			emit(c);
			i++;
		}
	}
	if (frame) closeFrame();
	return out;
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
	const title = fm ? (/(^|\n)title:\s*(.+?)\s*(\n|$)/.exec(fm[1] || '') || [])[2] : null;
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
	if (addTitle && title && !hasTitle) body = `# ${title.replace(/^['"]|['"]$/g, '')}\n\n${body}`;
	return `${indexUrl ? `${INDEX_LINE_PREFIX}: ${indexUrl}\n\n` : ''}${body}\n`;
}

// First line of every published .md twin; llms.js uses it to spot an already-rewritten file.
const INDEX_LINE_PREFIX = '> Documentation index for agents';

module.exports = { cleanTwin, splitFences, INDEX_LINE_PREFIX };
