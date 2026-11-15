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
// PAGE DOM — reading and acting on the preview's document from the builder's realm
// =============================================================================

/**
 * The DOM work behind the agent's app page, over the preview iframe's Window. The blob page is
 * same-origin and not sandboxed, so the builder reads it directly. The helpers live builder-side, not on
 * __rrShellDev, because the preview runs whatever shell the server serves, which can be older than the
 * builder.
 *
 * Realm rules, each one a bug when broken:
 * - Classes, getComputedStyle and event constructors come from the frame's window
 *   (`win.MutationObserver`, `new win.MouseEvent`), never the builder's: a cross-realm `instanceof` is
 *   always false. Elements are told apart by tag name.
 * - Nothing here keeps the document: a reload replaces it. Callers pass `win` each time.
 * - No focus(): the builder's chat composer keeps the keyboard. type and select set values and send
 *   events; a key with no ref goes to whatever the page already focused.
 *
 * Only appPage.ts imports this module.
 */

import type { ElementRef, OutlineLine, OutlineState, PageAction } from 'shared/modules/agent/host';
import { PAGE_TEXT } from './pageText';

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
// ACTIONS — events built in the frame's realm
// =============================================================================

/** An action on an element: every kind but wait_for, which reads the page instead. */
export type ElementAction = Exclude<PageAction, { kind: 'wait_for' }>;

/** The frame's window with its own constructors, which build the events. */
type Realm = Window & typeof globalThis;

/**
 * Does one action on its element.
 *
 * - click: what a person's click sends, at the element's centre: pointerdown, mousedown, pointerup and
 *   mouseup, then el.click() for the click and its default action. So a component that listens on
 *   pointer or mouse down works too.
 * - type: the new value through the realm's native setter, so React's value tracker sees a change, then
 *   a bubbling `input`. Inputs and text areas only.
 * - select: a native select's option, by value or label, then `input` and `change`.
 * - press: keydown, then keyup. Enter in a form's input also calls requestSubmit(), because a synthetic
 *   Enter submits nothing; not when the page cancelled the keydown, as a browser wouldn't either.
 *
 * @returns Why the element can't take the action, or null when it was done.
 */
export function act(win: Window, el: Element, action: ElementAction): string | null {
	if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return PAGE_TEXT.disabled;
	const realm = win as Realm;
	switch (action.kind) {
		case 'click':
			return click(realm, el);
		case 'type':
			return type(realm, el, action.text);
		case 'select':
			return select(realm, el, action.value);
		case 'press':
			return press(realm, el, action.key);
	}
}

function click(realm: Realm, el: Element): null {
	const box = el.getBoundingClientRect();
	const at: MouseEventInit = { bubbles: true, cancelable: true, composed: true, view: realm, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
	const pointer: PointerEventInit = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true };
	el.dispatchEvent(new realm.PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
	el.dispatchEvent(new realm.MouseEvent('mousedown', { ...at, buttons: 1 }));
	el.dispatchEvent(new realm.PointerEvent('pointerup', pointer));
	el.dispatchEvent(new realm.MouseEvent('mouseup', at));
	// step: an SVG element has no click(), and its click has no default action to run
	if (typeof (el as HTMLElement).click === 'function') (el as HTMLElement).click();
	else el.dispatchEvent(new realm.MouseEvent('click', at));
	return null;
}

function type(realm: Realm, el: Element, text: string): string | null {
	const field = el.localName === 'textarea' ? realm.HTMLTextAreaElement.prototype : el.localName === 'input' && !VALUELESS_INPUTS.has((el as HTMLInputElement).type) ? realm.HTMLInputElement.prototype : null;
	if (!field || (el as HTMLInputElement).readOnly) return PAGE_TEXT.notTextField;
	Object.getOwnPropertyDescriptor(field, 'value')?.set?.call(el, text);
	el.dispatchEvent(new realm.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
	return null;
}

function select(realm: Realm, el: Element, value: string): string | null {
	if (el.localName !== 'select') return PAGE_TEXT.notSelect;
	// step: a disabled option is no choice a person has
	const options = [...(el as HTMLSelectElement).options].filter((option) => !option.disabled);
	const labels = options.map((option) => clean(option.label));
	const wanted = clean(value).toLowerCase();
	const option = options.find((o) => o.value === value) ?? options[labels.findIndex((label) => label.toLowerCase() === wanted)];
	if (!option) return PAGE_TEXT.noOption(value, labels);
	option.selected = true;
	el.dispatchEvent(new realm.Event('input', { bubbles: true }));
	el.dispatchEvent(new realm.Event('change', { bubbles: true }));
	return null;
}

function press(realm: Realm, el: Element, key: string): null {
	const init: KeyboardEventInit = { key, bubbles: true, cancelable: true, composed: true, view: realm };
	const proceed = el.dispatchEvent(new realm.KeyboardEvent('keydown', init));
	const form = el.localName === 'input' ? (el as HTMLInputElement).form : null;
	if (key === 'Enter' && proceed && form) form.requestSubmit();
	el.dispatchEvent(new realm.KeyboardEvent('keyup', init));
	return null;
}

/**
 * What a field holds as properties, which no MutationObserver sees change: the value typed or chosen,
 * and whether a box is ticked. An action compares it before and after, so typing that changes only the
 * value still counts as a change. Undefined for an element that is no field.
 */
export function fieldState(el: Element): string | undefined {
	switch (el.localName) {
		case 'input':
			return `${(el as HTMLInputElement).checked} ${(el as HTMLInputElement).value}`;
		case 'textarea':
			return (el as HTMLTextAreaElement).value;
		case 'select':
			return [...(el as HTMLSelectElement).options].map((option) => (option.selected ? '1' : '0')).join('');
	}
	return undefined;
}

/** Whether the text shows on the page: the body's rendered text (innerText skips hidden text), case and spacing ignored. */
export function findText(doc: Document, text: string): boolean {
	return doc.body ? clean(doc.body.innerText).toLowerCase().includes(clean(text).toLowerCase()) : false;
}

// =============================================================================
// GUARDS — what the page can't be allowed to do to the builder
// =============================================================================

/** Marks a document's window whose dialogs are answered, so answering the same document again does nothing. */
const ANSWERED = Symbol('use_app answers dialogs');

/**
 * Answers the page's blocking dialogs for the rest of its document's life. The frame is same-origin in
 * the user's tab, so an alert, confirm or prompt the app raises at any time, on load or between actions
 * too, would block the whole builder and show the user a dialog.
 *
 * - alert: dismissed. confirm: answered OK, because the agent chose to use the app. prompt: cancelled.
 * - `heard` gets one note per dialog, saying what it said and how it was answered.
 *
 * A reload brings a new window behind the frame with its own dialogs, so the caller answers each new
 * document (the shell's devReady comes before the app's code runs). A window already answered is skipped.
 */
export function answerDialogs(win: Window, heard: (note: string) => void): void {
	if (Object.hasOwn(win, ANSWERED)) return;
	win.alert = (message?: unknown): void => heard(PAGE_TEXT.alerted(String(message ?? '')));
	win.confirm = (message?: string): boolean => {
		heard(PAGE_TEXT.confirmed(String(message ?? '')));
		return true;
	};
	win.prompt = (message?: string): null => {
		heard(PAGE_TEXT.prompted(String(message ?? '')));
		return null;
	};
	Object.defineProperty(win, ANSWERED, { value: true });
}

/**
 * Holds the page's new tabs for one action and its settle: window.open and a click on a target=_blank
 * link would open real tabs. Each is held and noted with its address.
 *
 * @returns The notes so far, and restore(), which gives the page its own window.open back. A page that
 *   reloaded or left meanwhile has a fresh one, so restore leaves it alone.
 */
export function holdNewTabs(win: Window): { said(): string[]; restore(): void } {
	const notes: string[] = [];
	const doc = win.document;
	const own = win.open;
	win.open = (url?: string | URL): null => {
		notes.push(PAGE_TEXT.newTab(String(url ?? '')));
		return null;
	};
	const holdLink = (e: Event): void => {
		const link = (e.target as Element | null)?.closest?.('a[target="_blank" i], area[target="_blank" i]');
		if (!link) return;
		e.preventDefault();
		notes.push(PAGE_TEXT.newTab((link as HTMLAnchorElement).href));
	};
	win.addEventListener('click', holdLink, true);
	return {
		said: () => [...notes],
		restore: () => {
			try {
				if (win.document !== doc) return;
				win.open = own;
				win.removeEventListener('click', holdLink, true);
			} catch {
				// a page that went to another origin can't be touched, and kept none of these anyway
			}
		},
	};
}

// =============================================================================
// SETTLING
// =============================================================================

/**
 * Waits until the document has had no DOM change for `quietMs`, at most `capMs`, through a MutationObserver
 * built from the frame's realm. Its callbacks are microtasks, so an offscreen frame's timer throttling
 * doesn't delay them; the timers are the builder's own for the same reason. It watches from the call on,
 * so call it before an action whose handlers may change the DOM as they run.
 *
 * @returns Whether anything changed since the call.
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
