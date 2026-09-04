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
 * XSS suite for the safe assistant-output renderer (src/render.ts).
 *
 * The renderer receives untrusted model output and must escape ALL HTML
 * before applying its minimal formatting (paragraphs, `code`, fenced code,
 * **bold**, http(s)-only links). These tests assert the exact safe HTML for
 * canonical inputs plus a structural allowlist invariant for adversarial ones.
 */

import { srcExists, tryRequire, assertSafeHtml } from './helpers';

const hasRender = srcExists('render');
const renderModule = hasRender ? tryRequire('../src/render') : null;

describe('module availability', () => {
	it('loads src/render.ts when present', () => {
		if (!hasRender) {
			console.warn('[chat-widget tests] src/render.ts not on disk yet — render suite skipped');
			return;
		}
		expect(renderModule).toBeTruthy();
		expect(typeof (renderModule as Record<string, unknown>).renderMessageHtml).toBe('function');
	});
});

const d = renderModule ? describe : describe.skip;

d('render.ts — safe assistant output renderer', () => {
	const render = (text: string): string =>
		(renderModule as { renderMessageHtml(text: string): string }).renderMessageHtml(text);

	describe('escaping (XSS)', () => {
		it('escapes <script> tags', () => {
			const html = render('<script>alert(1)</script>');
			expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
			expect(html).not.toMatch(/<script/i);
			assertSafeHtml(html);
		});

		it('escapes img/onerror payloads', () => {
			const html = render('<img src=x onerror=alert(1)>');
			expect(html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
			expect(html).not.toMatch(/<img/i);
			assertSafeHtml(html);
		});

		it('escapes event-handler attributes and quotes', () => {
			const html = render('<div onclick="steal()">x</div>');
			expect(html).toBe('<p>&lt;div onclick=&quot;steal()&quot;&gt;x&lt;/div&gt;</p>');
			assertSafeHtml(html);
		});

		it('escapes the five HTML-significant characters', () => {
			const mod = renderModule as { escapeHtml?(text: string): string };
			if (typeof mod.escapeHtml !== 'function') {
				console.warn('[chat-widget tests] escapeHtml not exported — skipping');
				return;
			}
			expect(mod.escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
		});

		it('does not double-escape but re-escapes pre-escaped input (raw text in, raw text out)', () => {
			expect(render('a & b')).toBe('<p>a &amp; b</p>');
			expect(render('&lt;script&gt;')).toBe('<p>&amp;lt;script&amp;gt;</p>');
		});

		it('escapes iframe/svg/style vectors', () => {
			for (const payload of [
				'<iframe src="https://evil.test"></iframe>',
				'<svg onload=alert(1)>',
				'<style>@import "https://evil.test";</style>',
			]) {
				const html = render(payload);
				expect(html).not.toMatch(/<(iframe|svg|style)/i);
				assertSafeHtml(html);
			}
		});
	});

	describe('links (http(s) only)', () => {
		it('does not linkify javascript: markdown links', () => {
			const html = render('[click](javascript:alert(1))');
			expect(html).toBe('<p>[click](javascript:alert(1))</p>');
			expect(html).not.toMatch(/<a\s/i);
			assertSafeHtml(html);
		});

		it('does not linkify bare javascript:/data:/vbscript: URLs', () => {
			for (const payload of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)', '[x](data:text/html,x)']) {
				const html = render(payload);
				expect(html).not.toMatch(/<a\s/i);
				assertSafeHtml(html);
			}
		});

		it('linkifies bare https URLs with rel="noopener noreferrer" target="_blank"', () => {
			const html = render('see https://example.com/docs now');
			expect(html).toBe(
				'<p>see <a href="https://example.com/docs" rel="noopener noreferrer" target="_blank">https://example.com/docs</a> now</p>'
			);
			assertSafeHtml(html);
		});

		it('linkifies markdown links with escaped labels', () => {
			const html = render('[RocketRide <docs>](https://docs.example.test/start)');
			expect(html).toBe(
				'<p><a href="https://docs.example.test/start" rel="noopener noreferrer" target="_blank">RocketRide &lt;docs&gt;</a></p>'
			);
			assertSafeHtml(html);
		});

		it('keeps query strings entity-escaped inside href', () => {
			const html = render('https://example.com/docs?a=1&b=2');
			expect(html).toBe(
				'<p><a href="https://example.com/docs?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">https://example.com/docs?a=1&amp;b=2</a></p>'
			);
			assertSafeHtml(html);
		});

		it('survives attribute-breakout attempts in URLs', () => {
			const html = render('https://example.com/" onmouseover="alert(1)');
			// Whatever the exact tokenization, no anchor may carry an event handler
			// and no raw quote may enter the markup stream.
			expect(html).not.toMatch(/<a[^>]*\bon[a-z]+\s*=/i);
			assertSafeHtml(html);
		});

		it('does not linkify href-like text produced by earlier passes (no double-linkify)', () => {
			const html = render('[label](https://example.com/path)');
			// Exactly one anchor: the bare-URL pass must not re-match the emitted href.
			expect(html.match(/<a\s/g)).toHaveLength(1);
			assertSafeHtml(html);
		});
	});

	describe('formatting after escaping', () => {
		it('renders **bold**', () => {
			expect(render('**important**')).toBe('<p><strong>important</strong></p>');
		});

		it('escapes THEN formats (HTML inside bold stays escaped)', () => {
			const html = render('**<b>x</b>**');
			expect(html).toBe('<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>');
			assertSafeHtml(html);
		});

		it('renders inline code with escaped content', () => {
			expect(render('`a < b & c`')).toBe('<p><code>a &lt; b &amp; c</code></p>');
		});

		it('applies no formatting inside inline code', () => {
			expect(render('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
		});

		it('renders fenced code blocks with language class and escaped content', () => {
			const html = render('```js\nconst a = 1 < 2;\n```');
			expect(html).toBe('<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>');
			assertSafeHtml(html);
		});

		it('applies no formatting and full escaping inside fenced blocks', () => {
			const html = render('```\n<script>x</script>\n**nb**\n```');
			expect(html).toBe('<pre><code>&lt;script&gt;x&lt;/script&gt;\n**nb**</code></pre>');
			expect(html).not.toMatch(/<strong>/);
			assertSafeHtml(html);
		});

		it('renders text around fenced blocks as paragraphs', () => {
			const html = render('before\n\n```\ncode\n```\n\nafter');
			expect(html).toBe('<p>before</p><pre><code>code</code></pre><p>after</p>');
		});

		it('splits paragraphs on blank lines and keeps <br> for single newlines', () => {
			expect(render('first\n\nsecond line1\nline2')).toBe('<p>first</p><p>second line1<br>line2</p>');
		});

		it('normalizes CRLF line endings', () => {
			expect(render('a\r\n\r\nb')).toBe('<p>a</p><p>b</p>');
		});

		it('returns an empty string for empty/whitespace input', () => {
			expect(render('')).toBe('');
			expect(render('   ')).toBe('');
		});
	});

	describe('internal token sentinel cannot be forged', () => {
		it('strips NUL characters from input', () => {
			expect(render('a\u00000\u0000b')).toBe('<p>a0b</p>');
		});

		it('NUL-wrapped indices in input cannot address the stash', () => {
			const html = render('`x` \u00000\u0000');
			expect(html).toBe('<p><code>x</code> 0</p>');
			assertSafeHtml(html);
		});

		it('restores nested tokens: inline code inside a markdown link label', () => {
			const html = render('[`x`](https://a.com)');
			expect(html).toBe(
				'<p><a href="https://a.com" rel="noopener noreferrer" target="_blank"><code>x</code></a></p>'
			);
			expect(html.includes(String.fromCharCode(0))).toBe(false);
			assertSafeHtml(html);
		});

		it('leaves no sentinel behind when a bare URL absorbs a stashed token', () => {
			const html = render('the [`useState`](https://docs.example/foo) hook, see https://a.com/`x` too');
			expect(html).toContain('<code>useState</code>');
			expect(html.includes(String.fromCharCode(0))).toBe(false);
			assertSafeHtml(html);
		});
	});

	describe('adversarial corpus invariant', () => {
		const corpus = [
			'<scr<script>ipt>alert(1)</scr</script>ipt>',
			'"><svg/onload=alert(1)>',
			'`<code>`',
			'** ** ** **',
			'[a](https://x.test) [b](javascript:y) `z`',
			'```\n``\n```',
			'[![img](https://x.test/i.png)](https://x.test)',
			'https://example.com/**bold**',
			'<a href="https://good.test" onclick="evil()">x</a>',
			'&#60;script&#62;alert(1)&#60;/script&#62;',
		];

		it.each(corpus)('emits only allow-listed, handler-free markup for %s', (payload) => {
			assertSafeHtml(render(payload));
		});
	});
});
