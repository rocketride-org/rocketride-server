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
// markdown — chat answers render as a safe subset of Markdown
// =============================================================================
//
// An answer is model output over stored documents, so it is untrusted text.
// The rules: HTML in it is shown as text and never interpreted, no image is
// ever loaded (an image becomes its alt text), links go only to http(s) and
// mailto and carry rel="noopener noreferrer nofollow", and code blocks are
// shown as code whatever their language label says.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LINK_REL, MARKDOWN_MAX_CHARS, parseMarkdown, plainText, safeHref } from '../src/vector/markdown';
import type { MdBlock, MdInline } from '../src/vector/markdown';
import { Markdown } from '../src/chat/Markdown';

/**
 * Every inline node of a block tree, depth first.
 *
 * @param blocks - The blocks.
 * @returns The inline nodes.
 */
function inlines(blocks: readonly MdBlock[]): MdInline[] {
	const out: MdInline[] = [];
	const walkInline = (nodes: readonly MdInline[]): void => {
		for (const node of nodes) {
			out.push(node);
			if ('children' in node) walkInline(node.children);
		}
	};
	const walk = (list: readonly MdBlock[]): void => {
		for (const block of list) {
			switch (block.type) {
				case 'paragraph':
				case 'heading':
					walkInline(block.children);
					break;
				case 'quote':
					walk(block.children);
					break;
				case 'list':
					for (const item of block.items) walk(item);
					break;
				case 'table':
					for (const cell of block.header) walkInline(cell);
					for (const row of block.rows) for (const cell of row) walkInline(cell);
					break;
				default:
					break;
			}
		}
	};
	walk(blocks);
	return out;
}

/**
 * The links of a block tree.
 *
 * @param blocks - The blocks.
 * @returns The link nodes.
 */
function links(blocks: readonly MdBlock[]): Array<Extract<MdInline, { type: 'link' }>> {
	return inlines(blocks).filter((node): node is Extract<MdInline, { type: 'link' }> => node.type === 'link');
}

/**
 * Render an answer to static HTML.
 *
 * @param text - The answer.
 * @returns The markup.
 */
function render(text: string): string {
	return renderToStaticMarkup(React.createElement(Markdown, { text }));
}

/** The only elements an answer may render. */
const SAFE_TAGS = new Set(['div', 'p', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 'del', 'a', 'br', 'span']);

/** The only attributes they may carry. */
const SAFE_ATTRIBUTES = new Set(['href', 'target', 'rel', 'style', 'start', 'scope', 'data-lang', 'data-markdown']);

/**
 * Assert that rendered markup holds only allowlisted elements and attributes.
 * React escapes text, so every '<' left in the markup opens a real element.
 *
 * @param html - The markup.
 * @param context - What is being checked, for the message.
 */
function assertSafeMarkup(html: string, context: string): void {
	for (const tag of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
		assert.ok(SAFE_TAGS.has(tag[1].toLowerCase()), `${context}: element <${tag[1]}>`);
		for (const attribute of tag[2].matchAll(/([^\s=/]+)(?:="[^"]*")?/g)) {
			assert.ok(SAFE_ATTRIBUTES.has(attribute[1].toLowerCase()), `${context}: attribute ${attribute[1]} on <${tag[1]}>`);
		}
		const href = /\shref="([^"]*)"/.exec(tag[2]);
		if (href) assert.match(href[1], /^(https?:\/\/|mailto:)/i, `${context}: href ${href[1]}`);
	}
}

test('markdown: raw HTML is text, never markup', () => {
	const answer = 'Before <script>alert(1)</script> after <img src="https://x.example/p.png" onerror="alert(2)"> and <b>bold?</b>';
	const blocks = parseMarkdown(answer);
	assert.equal(plainText(blocks), answer);
	const html = render(answer);
	assertSafeMarkup(html, 'raw HTML');
	assert.doesNotMatch(html, /<script|<img|<b>/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('markdown: no image is ever produced; remote and data images become their alt text', () => {
	for (const answer of ['See ![the chart](https://tracker.example/pixel.png?u=1) here', 'See ![the chart](data:image/png;base64,AAAA) here', 'See ![the chart](//tracker.example/pixel.png) here']) {
		const blocks = parseMarkdown(answer);
		const serialised = JSON.stringify(blocks);
		assert.doesNotMatch(serialised, /tracker\.example|data:image|"image"/, answer);
		assert.equal(plainText(blocks), 'See the chart here');
		assert.doesNotMatch(render(answer), /<img/);
	}
	// An image with no alt text still leaves a readable word.
	assert.equal(plainText(parseMarkdown('![](https://x.example/a.png)')), 'image');
});

test('markdown: links go only to http, https and mailto, and always carry the nofollow rel', () => {
	assert.equal(LINK_REL, 'noopener noreferrer nofollow');
	const blocks = parseMarkdown('[docs](https://docs.example/a?b=1) and [mail](mailto:ops@example.com) and [plain](http://intranet.example/x)');
	assert.deepEqual(
		links(blocks).map((link) => [link.href, link.rel]),
		[
			['https://docs.example/a?b=1', LINK_REL],
			['mailto:ops@example.com', LINK_REL],
			['http://intranet.example/x', LINK_REL],
		]
	);
	const html = render('[docs](https://docs.example/a)');
	assertSafeMarkup(html, 'link');
	const anchor = /<a\s([^>]*)>docs<\/a>/.exec(html);
	assert.ok(anchor, html);
	assert.match(anchor[1], /\bhref="https:\/\/docs\.example\/a"/);
	assert.match(anchor[1], /\btarget="_blank"/);
	assert.match(anchor[1], /\brel="noopener noreferrer nofollow"/);
});

test('markdown: a link to any other scheme keeps its text and loses the link', () => {
	const hostile = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', '&#106;avascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/hosts', '//evil.example/x', '/relative/path', '#fragment', 'ftp://files.example/x'];
	for (const href of hostile) {
		const answer = `click [here](${href}) now`;
		const blocks = parseMarkdown(answer);
		assert.equal(links(blocks).length, 0, href);
		assert.match(plainText(blocks), /^click here/, href);
		const html = render(answer);
		assert.doesNotMatch(html, /<a /, href);
		assert.doesNotMatch(html.toLowerCase(), /href="(javascript|vbscript|data|file):/, href);
	}
});

test('safeHref: the allowlist itself', () => {
	assert.equal(safeHref('https://a.example/x'), 'https://a.example/x');
	assert.equal(safeHref(' http://a.example '), 'http://a.example');
	assert.equal(safeHref('MAILTO:a@b.example'), 'MAILTO:a@b.example');
	for (const bad of ['javascript:x', 'https://a.example/\nx', 'https://a b', '', 'https:', 'http//a', 'data:x', 'blob:https://a/x', '\u0000https://a']) {
		assert.equal(safeHref(bad), null, JSON.stringify(bad));
	}
});

test('markdown: autolinks and bare URLs become links without the trailing punctuation', () => {
	const blocks = parseMarkdown('See <https://a.example/x> or https://b.example/path_(1). Also <ops@example.com>.');
	assert.deepEqual(
		links(blocks).map((link) => link.href),
		['https://a.example/x', 'https://b.example/path_(1)', 'mailto:ops@example.com']
	);
	assert.match(plainText(blocks), /path_\(1\)\. Also/);
});

test('markdown: a fenced code block is code whatever its label (no live HTML)', () => {
	const answer = '```html\n<iframe src="https://x.example"></iframe>\n<b>x</b>\n```\n\n```chartjs\n{"type":"bar"}\n```';
	const blocks = parseMarkdown(answer);
	assert.deepEqual(
		blocks.map((block) => block.type),
		['code', 'code']
	);
	const first = blocks[0] as Extract<MdBlock, { type: 'code' }>;
	assert.equal(first.lang, 'html');
	assert.equal(first.text, '<iframe src="https://x.example"></iframe>\n<b>x</b>');
	const html = render(answer);
	assertSafeMarkup(html, 'code fences');
	assert.doesNotMatch(html, /<iframe|<b>|<canvas/);
	assert.match(html, /<pre[^>]*><code[^>]*>&lt;iframe/);
});

test('markdown: the common block shapes', () => {
	const answer = ['# Title', '', 'A paragraph with **bold**, *italic*, ~~gone~~ and `code`.', '', '- one', '- two', '  - nested', '', '3. third', '4. fourth', '', '> quoted *text*', '', '---', '', '| Name | Size |', '|:-----|-----:|', '| a.md | 12 |', '| b.md | 7 |'].join('\n');
	const blocks = parseMarkdown(answer);
	assert.deepEqual(
		blocks.map((block) => block.type),
		['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'table']
	);
	const heading = blocks[0] as Extract<MdBlock, { type: 'heading' }>;
	assert.equal(heading.level, 1);
	const para = blocks[1] as Extract<MdBlock, { type: 'paragraph' }>;
	assert.deepEqual(
		para.children.map((node) => node.type),
		['text', 'strong', 'text', 'em', 'text', 'del', 'text', 'code', 'text']
	);
	const bullets = blocks[2] as Extract<MdBlock, { type: 'list' }>;
	assert.equal(bullets.ordered, false);
	assert.equal(bullets.items.length, 2);
	assert.deepEqual(
		bullets.items[1].map((block) => block.type),
		['paragraph', 'list']
	);
	const numbered = blocks[3] as Extract<MdBlock, { type: 'list' }>;
	assert.equal(numbered.ordered, true);
	assert.equal(numbered.start, 3);
	const table = blocks[6] as Extract<MdBlock, { type: 'table' }>;
	assert.deepEqual(table.align, ['left', 'right']);
	assert.equal(table.rows.length, 2);
	assert.equal(plainText([table]).includes('a.md'), true);
});

test('markdown: snake_case and arithmetic stay text', () => {
	const blocks = parseMarkdown('Use file_name_here and 2 * 3 * 4 = 24.');
	assert.deepEqual(
		blocks.flatMap((block) => (block.type === 'paragraph' ? block.children.map((node) => node.type) : [])),
		['text']
	);
	assert.equal(plainText(blocks), 'Use file_name_here and 2 * 3 * 4 = 24.');
});

test('markdown: backslash escapes and entities are text', () => {
	assert.equal(plainText(parseMarkdown('\\*not italic\\* and \\[not a link\\](x)')), '*not italic* and [not a link](x)');
	assert.equal(plainText(parseMarkdown('Tom &amp; Jerry &lt;b&gt; &#65;&#x42;')), 'Tom & Jerry <b> AB');
	assert.doesNotMatch(render('&lt;script&gt;'), /<script/);
});

test('markdown: the stub LLM answer renders as one plain paragraph', () => {
	const answer = '[STUB-LLM] deterministic answer. prompt_chars=1572 context_quote="### Documents: | Document 1) Content: # Falcon Station"';
	const blocks = parseMarkdown(answer);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, 'paragraph');
	assert.equal(plainText(blocks), answer);
});

test('markdown: deep nesting and huge input are bounded', () => {
	const deep = '>'.repeat(500) + ' bottom';
	assert.doesNotThrow(() => parseMarkdown(deep));
	const nestedBrackets = '['.repeat(2000) + 'x' + ']'.repeat(2000);
	assert.doesNotThrow(() => parseMarkdown(nestedBrackets));
	const big = 'word '.repeat(100_000);
	const blocks = parseMarkdown(big, { maxChars: 1000 });
	assert.ok(plainText(blocks).length <= 1001 + 1);
	assert.match(plainText(blocks), /…$/);
});

/** Longest one answer of the full cap may take to parse (best of up to three runs). */
const PARSE_LIMIT_MS = 100;

test('markdown: no answer within the cap stalls the page; every hostile shape parses in under 100 ms', () => {
	const n = MARKDOWN_MAX_CHARS - 100;
	const fill = (unit: string): string => unit.repeat(Math.floor(n / unit.length));
	// Shapes that made a search cost (length × length) or (length × span):
	// whitespace runs inside table delimiters, headings and paragraphs, and
	// openers that are never closed.
	const shapes: Array<[string, string]> = [
		['table delimiter: pipe then spaces', 'a|b\n|' + ' '.repeat(n) + 'x|'],
		['table delimiter: dash then spaces', 'a|b\n|-' + ' '.repeat(n) + '|x'],
		['heading: spaces inside', '# a' + ' '.repeat(n) + 'b'],
		['heading: spaces and tabs inside', '# a' + ' \t'.repeat(n / 2) + 'b'],
		['paragraph: a run of spaces', 'a' + ' '.repeat(n) + 'b'],
		['brackets never closed', '['.repeat(n)],
		['images never closed', fill('![')],
		['link destinations never closed', fill('[a](')],
		['emphasis never closed', fill('*a ')],
		['strong never closed', fill('**a ')],
		['underscores never closed', fill('_a ')],
		['strikethrough never closed', fill('~~a ')],
		['bare URLs ending in parentheses', fill('http://a' + ')'.repeat(1990) + ' ')],
		['bare URL look-alikes', fill('http:///-')],
		['email look-alikes', fill('<a@' + 'a.'.repeat(998) + ' ')],
		['rule look-alike', '- '.repeat(n / 2) + 'x'],
		['quotes nested deep', '> '.repeat(n / 2) + 'x'],
	];
	const slow: string[] = [];
	for (const [label, text] of shapes) {
		assert.ok(text.length <= MARKDOWN_MAX_CHARS, `${label}: the cap must not cut the input`);
		let best = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3 && best > PARSE_LIMIT_MS; run++) {
			const started = performance.now();
			parseMarkdown(text);
			best = Math.min(best, performance.now() - started);
		}
		if (best > PARSE_LIMIT_MS) slow.push(`${label}: ${Math.round(best)} ms`);
	}
	assert.deepEqual(slow, []);
});

test('markdown: once an answer has spent its search budget the rest is plain text, and the next answer is parsed in full', () => {
	const unclosed = '*a '.repeat(Math.floor((MARKDOWN_MAX_CHARS - 200) / 3));
	const hostile = `${unclosed}**late** and [docs](https://docs.example/a)`;
	const blocks = parseMarkdown(hostile);
	// Every character is still there to read; nothing past the budget became markup.
	assert.equal(plainText(blocks), hostile.trim());
	assert.equal(links(blocks).length, 0);
	// The budget belongs to one answer.
	const next = parseMarkdown('**bold** and [docs](https://docs.example/a)');
	assert.deepEqual(
		inlines(next).map((node) => node.type),
		['strong', 'text', 'text', 'link', 'text']
	);
});

test('markdown: random metacharacter soup never throws and never yields an unsafe link', () => {
	const alphabet = ['*', '_', '`', '[', ']', '(', ')', '!', '<', '>', '#', '-', '|', '\\', '~', '\n', ' ', 'a', 'javascript:', 'https://x.example', 'mailto:a@b.example', '&#106;', ':'];
	let seed = 11;
	const next = (n: number): number => {
		seed = (seed * 1103515245 + 12345) >>> 0;
		return (seed >>> 8) % n;
	};
	for (let round = 0; round < 400; round++) {
		let text = '';
		const length = next(60);
		for (let i = 0; i < length; i++) text += alphabet[next(alphabet.length)];
		const blocks = parseMarkdown(text);
		for (const link of links(blocks)) {
			assert.match(link.href, /^(https?:\/\/|mailto:)/i, text);
			assert.equal(link.rel, LINK_REL);
		}
		assertSafeMarkup(render(text), JSON.stringify(text));
	}
});
