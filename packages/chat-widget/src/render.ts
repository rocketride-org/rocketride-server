/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Safe minimal formatter for assistant output (XSS-critical).
 *
 * Model output is untrusted input. This module escapes ALL HTML first and only
 * then applies a small, allowlisted set of formatting rules:
 *
 * - paragraphs (blank-line separated) and line breaks
 * - fenced code blocks (```lang ... ```)
 * - inline `code`
 * - **bold**
 * - links — markdown `[text](url)` and bare URLs — for http(s) URLs ONLY,
 *   emitted with `rel="noopener noreferrer" target="_blank"`
 *
 * Raw model output is NEVER assigned to innerHTML; only the escaped/rebuilt
 * HTML produced here is. No external markdown dependency is used.
 *
 * @module render
 */

/** Escapes the five HTML-significant characters. Applied before any formatting. */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only http(s) URLs may become links — never javascript:, data:, etc. */
const SAFE_URL_PATTERN = /^https?:\/\//i;

/** Fenced code block: ```lang\n ... ``` (language tag optional). */
const FENCE_PATTERN = /```([A-Za-z0-9+#_-]*)\n?([\s\S]*?)```/g;

/** Markdown link on escaped text: [label](http(s)://target) — target has no spaces or ')'. */
const MD_LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi;

/** Bare http(s) URL on escaped text (trailing punctuation excluded). */
const BARE_URL_PATTERN = /https?:\/\/[^\s<>]*[^\s<>.,:;!?'")\]]/gi;

/** Inline code span: `code` (no backticks inside). */
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;

/** Bold span: **text**. */
const BOLD_PATTERN = /\*\*([^*\n]+(?:\*(?!\*)[^*\n]*)*)\*\*/g;

/**
 * Placeholder sentinel for already-rendered inline HTML. NUL characters are
 * stripped from the input during normalisation, so message content can never
 * forge a token.
 */
const TOKEN_MARK = '\u0000';

/** Matches a stashed token: NUL + index + NUL. */
const TOKEN_PATTERN = /\u0000(\d+)\u0000/g;

/**
 * Builds a safe anchor tag. `href` and `label` are already HTML-escaped.
 * The URL scheme was validated against {@link SAFE_URL_PATTERN} on the match.
 */
function anchorHtml(href: string, label: string): string {
	return `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`;
}

/**
 * Applies inline formatting (code, links, bold) to an escaped text fragment.
 * Uses opaque tokens so later passes cannot re-match HTML produced by earlier
 * passes (e.g. the bare-URL pass must not linkify an href attribute).
 */
function renderInline(escaped: string): string {
	const tokens: string[] = [];
	const stash = (html: string): string => {
		tokens.push(html);
		return `${TOKEN_MARK}${tokens.length - 1}${TOKEN_MARK}`;
	};

	let out = escaped;

	// 1. Inline code (content is verbatim; no further formatting inside).
	out = out.replace(INLINE_CODE_PATTERN, (_match, code: string) => stash(`<code>${code}</code>`));

	// 2. Markdown links [label](url) — http(s) only (enforced by the pattern).
	out = out.replace(MD_LINK_PATTERN, (_match, label: string, url: string) => stash(anchorHtml(url, label)));

	// 3. Bare URLs — http(s) only.
	out = out.replace(BARE_URL_PATTERN, (url: string) => (SAFE_URL_PATTERN.test(url) ? stash(anchorHtml(url, url)) : url));

	// 4. Bold.
	out = out.replace(BOLD_PATTERN, (_match, inner: string) => `<strong>${inner}</strong>`);

	// Restore stashed inline HTML. A stashed fragment can itself contain a
	// token sentinel — e.g. inline code inside a markdown link label, where the
	// link pass stashes an anchor whose label is a code token — and
	// String.replace does not re-scan replacement text, so restore recursively.
	// Fragments only ever reference tokens stashed in EARLIER passes (inline
	// code tokens contain no sentinels), so the recursion always terminates.
	const restore = (fragment: string): string =>
		fragment.replace(TOKEN_PATTERN, (_match, index: string) => restore(tokens[Number(index)]));
	out = restore(out);

	return out;
}

/** Wraps an escaped text fragment into paragraphs with <br> line breaks and inline formatting. */
function renderTextBlock(escaped: string): string {
	return escaped
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0)
		.map((paragraph) => `<p>${renderInline(paragraph).replace(/\n/g, '<br>')}</p>`)
		.join('');
}

/**
 * Renders untrusted message text to safe HTML.
 *
 * The returned string contains only tags produced by this module
 * (`p`, `br`, `pre`, `code`, `strong`, `a`) with all user/model content
 * HTML-escaped. Assigning it to innerHTML is safe by construction.
 *
 * @param text - Raw message text (untrusted model or user content)
 * @returns Safe HTML string
 */
export function renderMessageHtml(text: string): string {
	// Strip NULs so the internal token sentinel cannot be forged (see TOKEN_MARK).
	const normalized = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '');

	const parts: string[] = [];
	let lastIndex = 0;

	FENCE_PATTERN.lastIndex = 0;
	for (let match = FENCE_PATTERN.exec(normalized); match !== null; match = FENCE_PATTERN.exec(normalized)) {
		const [full, language, code] = match;
		if (match.index > lastIndex) {
			parts.push(renderTextBlock(escapeHtml(normalized.slice(lastIndex, match.index))));
		}
		const languageClass = language ? ` class="language-${language.toLowerCase()}"` : '';
		parts.push(`<pre><code${languageClass}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
		lastIndex = match.index + full.length;
	}
	if (lastIndex < normalized.length) {
		parts.push(renderTextBlock(escapeHtml(normalized.slice(lastIndex))));
	}

	return parts.join('');
}
