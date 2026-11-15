// MIT License
//
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
// PAGE DOM — reading the preview's document from the builder's realm
// =============================================================================

/**
 * The DOM work behind the agent's app page, over the preview iframe's Window. The blob page is
 * same-origin and not sandboxed, so the builder reads it directly. The helpers live builder-side, not on
 * __rrShellDev, because the preview runs whatever shell the server serves, which can be older than the
 * builder.
 *
 * Realm rules, each one a bug when broken:
 * - Classes and getComputedStyle come from the frame's window (`win.MutationObserver`), never the
 *   builder's: a cross-realm `instanceof` is always false. Elements are told apart by tag name.
 * - Nothing here keeps the document: a reload replaces it. Callers pass `win` each time.
 * - No focus(): the builder's chat composer keeps the keyboard.
 *
 * Only appPage.ts imports this module.
 */

import type { ElementRef, OutlineLine, OutlineState } from 'shared/modules/agent/host';

// =============================================================================
// REFS — stable for the page's life (the turn)
// =============================================================================

/**
 * Element refs for one page. An element keeps its ref across reads; a remount (rebuild, check_app,
 * reload) makes new elements, so their old refs report "gone". A hot refresh keeps most elements.
 */
export class RefBook {
	private next = 1;
	private readonly byElement = new WeakMap<Element, ElementRef>();
	private readonly byRef = new Map<ElementRef, WeakRef<Element>>();

	/** The element's ref, made on first sight. */
	refOf(el: Element): ElementRef {
		let ref = this.byElement.get(el);
		if (!ref) {
			ref = `e${this.next++}`;
			this.byElement.set(el, ref);
			this.byRef.set(ref, new WeakRef(el));
		}
		return ref;
	}

	/**
	 * The element a ref names in `doc`.
	 *
	 * @returns 'gone' when the element was removed or belongs to a document a reload replaced;
	 *   'unknown' for a ref this page never gave.
	 */
	find(ref: ElementRef, doc: Document): Element | 'gone' | 'unknown' {
		const held = this.byRef.get(ref);
		if (!held) return 'unknown';
		const el = held.deref();
		return el && el.isConnected && el.ownerDocument === doc ? el : 'gone';
	}
}

// =============================================================================
// OUTLINE
// =============================================================================

/** Roles whose children are indented under them; every other wrapper flattens. */
const NESTING_ROLES: ReadonlySet<string> = new Set(['dialog', 'alertdialog', 'form', 'list', 'menu', 'listbox', 'tablist', 'table', 'group']);

/** Roles that take actions and get a ref. So does anything with a click cursor that isn't inside one (React handlers are invisible from the DOM). */
const ACTIONABLE_ROLES: ReadonlySet<string> = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider', 'spinbutton']);

/** Roles that get a line even when they take no action. */
const LINE_ROLES: ReadonlySet<string> = new Set([...NESTING_ROLES, 'heading', 'img']);

/** Fields: their value is shown on their line, so their children (a select's options, a textarea's text) are not read. */
const FIELD_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton']);

/** Roles named only by their author (a label, aria-label, alt), never by their content: containers, fields and images. */
const AUTHOR_NAMED_ROLES: ReadonlySet<string> = new Set([...NESTING_ROLES, ...FIELD_ROLES, 'img', 'navigation']);

/** Input types with their own role; every other type is a textbox. */
const INPUT_ROLES: ReadonlyMap<string, string> = new Map([
	['checkbox', 'checkbox'],
	['radio', 'radio'],
	['range', 'slider'],
	['number', 'spinbutton'],
	['search', 'searchbox'],
	['button', 'button'],
	['submit', 'button'],
	['reset', 'button'],
	['image', 'button'],
	['file', 'button'],
]);

/** Input types whose value is no text the user typed. */
const VALUELESS_INPUTS: ReadonlySet<string> = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file']);

/** Tags whose content is never page text. */
const SKIPPED_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'template', 'iframe']);

/** The role on a line for an element that takes clicks but has no role of its own (a div with an onClick). */
const GENERIC_ROLE = 'generic';

/** The role on a line of plain text. */
const TEXT_ROLE = 'text';

/** What a filled password shows instead of its value. */
const PASSWORD_DOTS = '••••••••';

/** The longest one run of text or one name is kept here, in characters: a sanity bound only; the agent cuts for the model after hiding secrets. */
const TEXT_RUN_MAX_CHARS = 2_000;

/**
 * The page as lines: every visible element with a role, and the text outside elements that act, in
 * document order, over the whole document (body, the shell's popup portal, overlays).
 * Visible: not display:none, not visibility:hidden, not aria-hidden, with a size (the hidden preview
 * lays out at 1200x800, so sizes are real). Scrolled-out elements are listed.
 */
export function readOutline(win: Window, refs: RefBook): OutlineLine[] {
	const lines: OutlineLine[] = [];
	let run = '';
	let runDepth = 0;
	const flush = (): void => {
		const text = clean(run);
		run = '';
		if (text) lines.push({ depth: runDepth, role: TEXT_ROLE, name: text.slice(0, TEXT_RUN_MAX_CHARS), states: [] });
	};
	// named: inside an element whose content is its name, so only elements that act get lines there.
	// inAction: inside an element that acts, so the click cursor it passes down (CSS inherits it) means nothing.
	const walk = (parent: Node, depth: number, named: boolean, inAction: boolean): void => {
		for (let node = parent.firstChild; node; node = node.nextSibling) {
			if (node.nodeType === Node.TEXT_NODE) {
				if (!named) {
					if (!run) runDepth = depth;
					run += (node as Text).data;
				}
				continue;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) continue;
			const el = node as Element;
			if (el.localName === 'br') {
				if (run) run += ' ';
				continue;
			}
			if (SKIPPED_TAGS.has(el.localName)) continue;
			const style = win.getComputedStyle(el);
			if (!isVisible(el, style)) continue;
			const role = roleOf(el);
			const acts = (role !== null && ACTIONABLE_ROLES.has(role)) || (!inAction && style.cursor === 'pointer');
			const shown = acts || (!named && role !== null && LINE_ROLES.has(role));
			// step: a block or a line of its own ends the text run before it and starts a new one after it
			const boundary = shown || !style.display.startsWith('inline');
			if (boundary) flush();
			if (shown) {
				lines.push({
					depth,
					role: role ?? GENERIC_ROLE,
					name: accessibleName(el).slice(0, TEXT_RUN_MAX_CHARS),
					ref: acts ? refs.refOf(el) : undefined,
					value: valueOf(el),
					states: statesOf(el),
				});
			}
			if (role === null || !FIELD_ROLES.has(role)) {
				const nests = shown && role !== null && NESTING_ROLES.has(role);
				walk(el, nests ? depth + 1 : depth, named || (shown && namedByContent(role)), inAction || acts);
			}
			if (boundary) flush();
		}
	};
	if (win.document.body) walk(win.document.body, 0, false, false);
	flush();
	return lines;
}

/** The element's ARIA role: the role attribute, else the implicit one by tag and type; null for a plain wrapper. */
function roleOf(el: Element): string | null {
	const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
	if (explicit) return explicit === 'presentation' || explicit === 'none' ? null : explicit;
	switch (el.localName) {
		case 'button':
		case 'summary':
			return 'button';
		case 'a':
		case 'area':
			return el.hasAttribute('href') ? 'link' : null;
		case 'input':
			return INPUT_ROLES.get((el as HTMLInputElement).type) ?? 'textbox';
		case 'textarea':
			return 'textbox';
		case 'select':
			return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
		case 'option':
			return 'option';
		case 'h1':
		case 'h2':
		case 'h3':
		case 'h4':
		case 'h5':
		case 'h6':
			return 'heading';
		case 'img':
			// an empty alt marks decoration
			return el.getAttribute('alt') ? 'img' : null;
		case 'ul':
		case 'ol':
			return 'list';
		case 'li':
			return 'listitem';
		case 'dialog':
			return 'dialog';
		case 'form':
			return 'form';
		case 'table':
			return 'table';
		case 'fieldset':
			return 'group';
		case 'nav':
			return 'navigation';
	}
	// step: only the editing host is the textbox; its descendants are editable too
	const editable = el.getAttribute('contenteditable');
	return editable !== null && editable !== 'false' ? 'textbox' : null;
}

/** Whether a role takes its name from its content: everything but containers, fields and images (a generic clickable does too). */
function namedByContent(role: string | null): boolean {
	return role === null || !AUTHOR_NAMED_ROLES.has(role);
}

/**
 * An in-house accessible name (open question 5: switch to dom-accessibility-api if names come out wrong):
 * aria-labelledby, aria-label, its labels, alt, a button input's value, placeholder, then its content for
 * roles named by content, then title.
 */
export function accessibleName(el: Element): string {
	// step: in order, and only as far as the first that names it (content needs a layout read)
	const sources: Array<() => string | null | undefined> = [
		() =>
			el
				.getAttribute('aria-labelledby')
				?.split(/\s+/)
				.map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
				.join(' '),
		() => el.getAttribute('aria-label'),
		() => {
			const labels = (el as HTMLInputElement).labels;
			return labels ? [...labels].map((label) => labelText(label, el)).join(' ') : null;
		},
		() => el.getAttribute('alt'),
		() => (el.localName === 'input' && ['button', 'submit', 'reset'].includes((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : null),
		() => el.getAttribute('placeholder'),
		() => (namedByContent(roleOf(el)) ? contentName(el) : null),
		() => el.getAttribute('title'),
	];
	for (const source of sources) {
		const name = clean(source() ?? '');
		if (name) return name;
	}
	return '';
}

/** A label's text, without the text of the control it wraps. */
function labelText(label: Element, control: Element): string {
	let text = '';
	const walk = (parent: Node): void => {
		for (let node = parent.firstChild; node; node = node.nextSibling) {
			if (node === control) continue;
			if (node.nodeType === Node.TEXT_NODE) text += (node as Text).data;
			else if (node.nodeType === Node.ELEMENT_NODE && !SKIPPED_TAGS.has((node as Element).localName)) walk(node);
		}
	};
	walk(label);
	return text;
}

/** The rendered text inside; for an icon-only control, the first part inside that names itself. */
function contentName(el: Element): string {
	const text = clean('innerText' in el ? (el as HTMLElement).innerText : (el.textContent ?? ''));
	if (text) return text;
	const part = el.querySelector('[aria-label], img[alt], [title], svg title');
	return clean(part ? (part.getAttribute('aria-label') ?? part.getAttribute('alt') ?? part.getAttribute('title') ?? part.textContent ?? '') : '');
}

function isVisible(el: Element, style: CSSStyleDeclaration): boolean {
	if (el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
	// step: display:contents draws no box of its own, but its children do
	if (style.display === 'contents') return true;
	for (const rect of el.getClientRects()) {
		if (rect.width > 0 || rect.height > 0) return true;
	}
	return false;
}

/** A field's value as shown: input and textarea values, a select's chosen labels, a password as dots. */
function valueOf(el: Element): string | undefined {
	switch (el.localName) {
		case 'input': {
			const input = el as HTMLInputElement;
			if (VALUELESS_INPUTS.has(input.type)) return undefined;
			return input.type === 'password' && input.value ? PASSWORD_DOTS : input.value;
		}
		case 'textarea':
			return (el as HTMLTextAreaElement).value;
		case 'select':
			return [...(el as HTMLSelectElement).selectedOptions].map((option) => option.label).join(', ');
	}
	if (roleOf(el) === 'textbox') return clean((el as HTMLElement).innerText);
	return el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow') ?? undefined;
}

function statesOf(el: Element): OutlineState[] {
	const states: OutlineState[] = [];
	// step: :checked matches checked boxes and radios, and also chosen options, which read as selected
	const option = el.localName === 'option';
	if ((!option && el.matches(':checked')) || el.getAttribute('aria-checked') === 'true') states.push('checked');
	if ((option && el.matches(':checked')) || el.getAttribute('aria-selected') === 'true') states.push('selected');
	if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
	const expanded = el.getAttribute('aria-expanded');
	if (expanded === 'true') states.push('expanded');
	else if (expanded === 'false') states.push('collapsed');
	return states;
}

/** Whitespace collapsed and trimmed. */
function clean(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// =============================================================================
// SETTLING
// =============================================================================

/**
 * Waits until the document has had no DOM change for `quietMs`, at most `capMs`, through a MutationObserver
 * built from the frame's realm. Its callbacks are microtasks, so an offscreen frame's timer throttling
 * doesn't delay them; the timers are the builder's own for the same reason.
 *
 * @returns Whether anything changed while it waited.
 */
export function untilQuiet(win: Window, opts: { quietMs: number; capMs: number; signal?: AbortSignal }): Promise<{ changed: boolean }> {
	return new Promise((resolve) => {
		let changed = false;
		const finish = (): void => {
			observer.disconnect();
			clearTimeout(quiet);
			clearTimeout(cap);
			opts.signal?.removeEventListener('abort', finish);
			resolve({ changed });
		};
		const observer = new (win as Window & typeof globalThis).MutationObserver(() => {
			changed = true;
			clearTimeout(quiet);
			quiet = setTimeout(finish, opts.quietMs);
		});
		let quiet = setTimeout(finish, opts.quietMs);
		const cap = setTimeout(finish, opts.capMs);
		observer.observe(win.document, { subtree: true, childList: true, attributes: true, characterData: true });
		opts.signal?.addEventListener('abort', finish, { once: true });
		if (opts.signal?.aborted) finish();
	});
}
