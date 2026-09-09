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
 * Shared test helpers for the chat-widget suite.
 *
 * The suite is developed in parallel with the core component sources
 * (src/component.ts, src/render.ts, ...). Helpers here let tests target the
 * agreed module contract while degrading to skipped suites (with a visible
 * tripwire test) when a core source file has not landed yet.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Returns true when `src/<name>.ts` exists in this package. */
export function srcExists(name: string): boolean {
	return fs.existsSync(path.join(__dirname, '..', 'src', `${name}.ts`));
}

/**
 * Requires a module, returning `null` (with a warning) when it cannot be
 * loaded. Used to keep the suite runnable while sibling sources are still
 * landing; the "module availability" tripwire tests fail loudly when a file
 * exists on disk but cannot be required.
 */
export function tryRequire(modulePath: string): Record<string, unknown> | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require(modulePath);
	} catch (error) {
		console.warn(`[chat-widget tests] could not load ${modulePath}: ${(error as Error).message}`);
		return null;
	}
}

/** Picks the first export matching one of the candidate names. */
export function pickExport<T>(mod: Record<string, unknown> | null, names: string[]): T | null {
	if (!mod) {
		return null;
	}
	for (const name of names) {
		const candidate = (mod as Record<string, unknown>)[name];
		if (candidate !== undefined && candidate !== null) {
			return candidate as T;
		}
	}
	return null;
}

/** Flushes pending microtasks and zero-delay timers. */
export async function flush(rounds = 4): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/** Tags the safe renderer is allowed to emit. */
export const ALLOWED_TAGS = new Set([
	'p', 'br', 'div', 'span',
	'strong', 'b', 'em', 'i',
	'code', 'pre',
	'a',
	'ul', 'ol', 'li',
]);

interface ParsedTag {
	name: string;
	attrs: string;
	raw: string;
}

/**
 * Extracts every real HTML tag from a rendered string. Escaped markup
 * (`&lt;script&gt;`) contains no raw `<`, so anything matched here is markup
 * the renderer actually emitted.
 */
export function collectTags(html: string): ParsedTag[] {
	const tags: ParsedTag[] = [];
	const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
	let match: RegExpExecArray | null;
	while ((match = tagRe.exec(html)) !== null) {
		tags.push({ name: match[1].toLowerCase(), attrs: match[2] ?? '', raw: match[0] });
	}
	return tags;
}

/**
 * Core XSS invariant for rendered assistant output:
 * - only allow-listed tags,
 * - no event-handler attributes,
 * - no `javascript:` / `data:` / `vbscript:` URLs in any attribute,
 * - anchors restricted to http(s) href with the mandated rel/target.
 */
export function assertSafeHtml(html: string): void {
	// No raw '<' may survive outside a well-formed emitted tag: strip every
	// matched tag and verify nothing tag-like remains.
	const withoutTags = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, '');
	expect(withoutTags).not.toMatch(/[<>]/);

	for (const tag of collectTags(html)) {
		expect(Array.from(ALLOWED_TAGS)).toContain(tag.name);
		expect(tag.attrs).not.toMatch(/\bon[a-zA-Z]+\s*=/);
		expect(tag.attrs).not.toMatch(/(javascript|vbscript|data)\s*:/i);
		expect(tag.attrs).not.toMatch(/srcdoc|formaction|xlink:href/i);
		if (tag.name === 'a' && !tag.raw.startsWith('</')) {
			const href = /href\s*=\s*"([^"]*)"/.exec(tag.attrs)?.[1]
				?? /href\s*=\s*'([^']*)'/.exec(tag.attrs)?.[1];
			expect(href).toBeDefined();
			expect(href).toMatch(/^https?:\/\//i);
			expect(tag.attrs).toMatch(/target\s*=\s*["']_blank["']/);
			expect(tag.attrs).toMatch(/rel\s*=\s*["'][^"']*noopener[^"']*["']/);
			expect(tag.attrs).toMatch(/rel\s*=\s*["'][^"']*noreferrer[^"']*["']/);
		}
	}
}

/** Dispatches a composed, bubbling keydown on the given element. */
export function pressKey(
	target: EventTarget,
	key: string,
	init: KeyboardEventInit = {}
): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		composed: true,
		...init,
	});
	target.dispatchEvent(event);
	return event;
}
