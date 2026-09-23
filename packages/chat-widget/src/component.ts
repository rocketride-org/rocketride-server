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
 * <rocketride-chat> — framework-free web component for chatting with a
 * RocketRide pipeline.
 *
 * Usage (inline web-component mode):
 * ```html
 * <rocketride-chat engine-url="http://localhost:5565" auth="PUBLIC_AUTH_KEY" title="Support" accent="#5f2167" theme="auto"></rocketride-chat>
 * ```
 *
 * AUTH MODEL (security-critical): `auth` must be the pipeline's PUBLIC auth
 * key — the `?auth=` value from the chat source node's published link. The
 * value is visible to every visitor of the host page, so NEVER use an engine
 * API key or any private token here.
 *
 * Attributes (all observed; theme-affecting ones update live):
 * - `engine-url`  — RocketRide engine URL, e.g. `http://localhost:5565`
 * - `auth`        — the pipeline's PUBLIC auth key (see above)
 * - `title`       — header title (default 'RocketRide Assistant')
 * - `accent`      — brand accent color (default RocketRide violet #5f2167)
 * - `welcome`     — welcome message shown before the first exchange
 * - `placeholder` — input placeholder (default 'Type a message…')
 * - `theme`       — 'light' | 'dark' | 'auto' (default 'auto', follows prefers-color-scheme)
 *
 * Styling: shadow DOM isolates styles both ways; brand via CSS custom
 * properties (see styles.ts) which inherit into the shadow root.
 *
 * JS API: {@link RocketRideChatElement.sendMessage}, {@link RocketRideChatElement.clear}.
 * Events (composed, bubbling): 'rr-message' on every transcript entry,
 * 'rr-error' on connection/pipeline failures.
 *
 * @module component
 */

import { WidgetConnection } from './connection';
import { renderMessageHtml } from './render';
import { WIDGET_STYLES } from './styles';
import { ChatClientFactory, ChatHistoryItem, ChatMessage, ChatRole, ConnectionState, ErrorEventDetail, MessageEventDetail } from './types';

/** Custom element tag name. */
export const WIDGET_TAG = 'rocketride-chat';

const DEFAULT_TITLE = 'RocketRide Assistant';
const DEFAULT_PLACEHOLDER = 'Type a message…';
const DEFAULT_THINKING = 'Thinking…';

/** Distance (px) from the bottom within which autoscroll stays engaged. */
const AUTOSCROLL_THRESHOLD = 40;

/** Static shadow-DOM skeleton. Trusted template — never interpolated with user/model content. */
const TEMPLATE_HTML = `
<div class="rr-root" part="root">
	<header class="rr-header" part="header">
		<span class="rr-title"></span>
		<span class="rr-conn" data-state="idle"><span class="rr-conn-dot"></span><span class="rr-conn-label"></span></span>
	</header>
	<div class="rr-messages" role="log" aria-live="polite" aria-label="Chat messages">
		<div class="rr-thinking"><span class="rr-thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="rr-thinking-text"></span></div>
	</div>
	<div class="rr-error" role="alert" hidden>
		<span class="rr-error-text"></span>
		<button type="button" class="rr-retry">Retry</button>
	</div>
	<form class="rr-composer">
		<textarea class="rr-input" rows="1" aria-label="Chat message"></textarea>
		<button type="submit" class="rr-send" aria-label="Send message">
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg>
		</button>
	</form>
</div>
`;

/**
 * SSR-safe base class. In DOM-less runtimes (a Node/SSR `import` of the ESM
 * bundle) `HTMLElement` does not exist at module-evaluation time; the element
 * is never constructed there (registration is guarded on `customElements`),
 * so an inert stand-in keeps the import from throwing.
 */
const BaseElement: typeof HTMLElement = typeof HTMLElement !== 'undefined' ? HTMLElement : (class {} as unknown as typeof HTMLElement);

/**
 * The <rocketride-chat> custom element.
 *
 * Framework-free (no React); renders into an open shadow root. One element
 * owns one persistent engine connection (created when both `engine-url` and
 * `auth` are present and the element is in the document).
 */
export class RocketRideChatElement extends BaseElement {
	/** Attributes that trigger {@link attributeChangedCallback}. */
	static get observedAttributes(): string[] {
		return ['engine-url', 'auth', 'title', 'accent', 'welcome', 'placeholder', 'theme'];
	}

	/**
	 * Client factory override, used by unit tests to stub the SDK client.
	 * Assign before inserting the element into the document.
	 */
	clientFactory?: ChatClientFactory;

	private _connection: WidgetConnection | null = null;
	private _messages: ChatMessage[] = [];
	private _busy = false;
	/**
	 * Conversation identity counter, bumped by {@link clear} (which the
	 * engine-url/auth swap also runs). A reply from an in-flight `ask()` that
	 * captured an older generation belongs to a transcript that no longer
	 * exists, so it is dropped instead of being appended to the new one.
	 */
	private _generation = 0;
	private _stickToBottom = true;
	private _lastConnectionState: ConnectionState = 'idle';
	private _mediaQuery: MediaQueryList | null = null;
	private readonly _onMediaChange = (): void => this._applyTheme();

	private readonly _root: HTMLDivElement;
	private readonly _titleEl: HTMLElement;
	private readonly _connEl: HTMLElement;
	private readonly _connLabelEl: HTMLElement;
	private readonly _messagesEl: HTMLElement;
	private readonly _thinkingEl: HTMLElement;
	private readonly _thinkingTextEl: HTMLElement;
	private readonly _errorEl: HTMLElement;
	private readonly _errorTextEl: HTMLElement;
	private readonly _retryEl: HTMLButtonElement;
	private readonly _formEl: HTMLFormElement;
	private readonly _inputEl: HTMLTextAreaElement;
	private readonly _sendEl: HTMLButtonElement;

	/** Builds the shadow-DOM skeleton (styles, header, transcript, composer) and wires its listeners. */
	constructor() {
		super();
		const shadow = this.attachShadow({ mode: 'open' });

		const style = document.createElement('style');
		style.textContent = WIDGET_STYLES;
		shadow.appendChild(style);

		const template = document.createElement('template');
		template.innerHTML = TEMPLATE_HTML;
		shadow.appendChild(template.content.cloneNode(true));

		const query = <T extends Element>(selector: string): T => {
			const el = shadow.querySelector<T>(selector);
			if (!el) {
				throw new Error(`rocketride-chat: missing template element ${selector}`);
			}
			return el;
		};

		this._root = query<HTMLDivElement>('.rr-root');
		this._titleEl = query('.rr-title');
		this._connEl = query('.rr-conn');
		this._connLabelEl = query('.rr-conn-label');
		this._messagesEl = query('.rr-messages');
		this._thinkingEl = query('.rr-thinking');
		this._thinkingTextEl = query('.rr-thinking-text');
		this._errorEl = query('.rr-error');
		this._errorTextEl = query('.rr-error-text');
		this._retryEl = query<HTMLButtonElement>('.rr-retry');
		this._formEl = query<HTMLFormElement>('.rr-composer');
		this._inputEl = query<HTMLTextAreaElement>('.rr-input');
		this._sendEl = query<HTMLButtonElement>('.rr-send');

		this._formEl.addEventListener('submit', (event) => {
			event.preventDefault();
			void this._submit();
		});
		// Enter sends, Shift+Enter inserts a newline.
		this._inputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void this._submit();
			}
		});
		this._inputEl.addEventListener('input', () => this._autosizeInput());
		// Autoscroll respects a user who scrolled up to read history.
		this._messagesEl.addEventListener('scroll', () => {
			this._stickToBottom = this._messagesEl.scrollHeight - this._messagesEl.scrollTop - this._messagesEl.clientHeight < AUTOSCROLL_THRESHOLD;
		});
		this._retryEl.addEventListener('click', () => {
			this._hideError();
			void this._connection?.retry().catch(() => {
				/* state is reported through onStateChange */
			});
		});
	}

	// ============================================================================
	// PUBLIC JS API
	// ============================================================================

	/** Read-only copy of the transcript. */
	get messages(): readonly ChatMessage[] {
		return [...this._messages];
	}

	/** Current connection state ('idle' | 'connecting' | 'connected' | 'error'). */
	get connectionState(): ConnectionState {
		return this._lastConnectionState;
	}

	/** True while a question is in flight and the composer is disabled. */
	get busy(): boolean {
		return this._busy;
	}

	/**
	 * Sends a message programmatically, exactly as if the user typed it.
	 * Resolves once the assistant reply (or an error notice) was appended.
	 */
	async sendMessage(text: string): Promise<void> {
		await this._send(text);
	}

	/**
	 * Clears the transcript back to the welcome message (if configured).
	 *
	 * Also ends any pending-reply state: the request in flight now belongs to a
	 * conversation that no longer exists, so the user must be able to type the
	 * next question immediately rather than wait for an answer that will be
	 * discarded on arrival.
	 */
	clear(): void {
		// Invalidate any in-flight ask(): its answer belongs to the transcript
		// being discarded here, not to the one the user sees next.
		this._generation++;
		this._messages = [];
		for (const el of Array.from(this._messagesEl.querySelectorAll('.rr-msg'))) {
			el.remove();
		}
		this._showWelcome();
		if (this._busy) {
			// Release the composer now; the abandoned request cannot do it,
			// because its cleanup no longer owns the visible conversation (and
			// an SDK chat() that never settles would never run it at all).
			this._setBusy(false);
			this._inputEl.focus();
		}
	}

	// ============================================================================
	// CUSTOM-ELEMENT LIFECYCLE
	// ============================================================================

	/** Applies appearance, starts the theme watcher and connects once the element enters the document. */
	connectedCallback(): void {
		this._applyTitle();
		this._applyAccent();
		this._applyPlaceholder();
		this._applyTheme();
		this._watchMedia();
		this._showWelcome();
		this._applyConnectionState('idle');
		this._maybeConnect();
	}

	/** Stops the theme watcher and tears the connection down when the element leaves the document. */
	disconnectedCallback(): void {
		this._unwatchMedia();
		this._teardownConnection();
	}

	/** Reacts to an observed attribute change: reconnects on credentials, re-applies appearance otherwise. */
	attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
		if (oldValue === newValue || !this.isConnected) {
			return;
		}
		switch (name) {
			case 'engine-url':
			case 'auth':
				// The transcript belongs to the previous engine/auth context.
				// Keeping it would replay that conversation into _historyItems()
				// and hand it to the new engine on the very next question.
				this.clear();
				this._teardownConnection();
				this._maybeConnect();
				break;
			case 'title':
				this._applyTitle();
				break;
			case 'accent':
				this._applyAccent();
				break;
			case 'placeholder':
				this._applyPlaceholder();
				break;
			case 'theme':
				this._applyTheme();
				break;
			case 'welcome':
				this._refreshWelcome();
				break;
		}
	}

	// ============================================================================
	// CONNECTION
	// ============================================================================

	/** Opens a connection when the element is in the document and both `engine-url` and `auth` are set. */
	private _maybeConnect(): void {
		if (!this.isConnected || this._connection) {
			return;
		}
		const engineUrl = this.getAttribute('engine-url');
		const auth = this.getAttribute('auth');
		if (!engineUrl || !auth) {
			return;
		}

		const connection = new WidgetConnection({
			engineUrl,
			auth,
			createClient: this.clientFactory,
			onStateChange: (state, detail) => {
				if (this._connection !== connection) {
					return; // stale callback from a replaced connection
				}
				this._applyConnectionState(state, detail);
			},
		});
		this._connection = connection;

		void connection.connect().catch((error: unknown) => {
			if (this._connection !== connection) {
				return;
			}
			const message = error instanceof Error ? error.message : 'Failed to connect';
			this._applyConnectionState('error', message);
		});
	}

	/**
	 * Drops the current connection (best-effort disconnect) and returns the
	 * header to the idle state.
	 *
	 * `disconnect()` abandons every `ask()` still in flight on that connection,
	 * so the engine-url/auth swap cannot leave the widget waiting on a socket
	 * it has already closed; the composer is released here for the same reason
	 * `clear()` releases it.
	 */
	private _teardownConnection(): void {
		const connection = this._connection;
		this._connection = null;
		if (connection) {
			void connection.disconnect().catch(() => {
				/* already tearing down */
			});
		}
		if (this._busy) {
			this._setBusy(false);
		}
		this._applyConnectionState('idle');
	}

	/** Reflects a connection state in the header, error banner and composer, emitting `rr-error` on entry to `error`. */
	private _applyConnectionState(state: ConnectionState, detail?: string): void {
		const previous = this._lastConnectionState;
		this._lastConnectionState = state;

		this._connEl.setAttribute('data-state', state);
		const labels: Record<ConnectionState, string> = {
			idle: '',
			connecting: 'Connecting…',
			connected: 'Online',
			error: 'Offline',
		};
		this._connLabelEl.textContent = labels[state];

		if (state === 'error') {
			this._showError(detail || 'Connection failed');
			if (previous !== 'error') {
				this._dispatchError({ message: detail || 'Connection failed', source: 'connection' });
			}
		} else {
			this._hideError();
		}

		this._syncComposerState();
	}

	// ============================================================================
	// SENDING
	// ============================================================================

	/** Sends whatever is currently in the composer (form submit / Enter handler). */
	private async _submit(): Promise<void> {
		await this._send(this._inputEl.value);
	}

	/** Appends the question, asks the pipeline with prior history, then appends the answers or an error notice. */
	private async _send(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed || this._busy) {
			return;
		}
		const connection = this._connection;
		if (!connection || !connection.isConnected()) {
			this._appendMessage({ role: 'system', text: 'Not connected yet — please wait a moment and try again.', transient: true });
			return;
		}

		// Capture history before appending the new question (mirrors chat-ui).
		const history = this._historyItems();
		// Capture the conversation identity this request belongs to.
		const generation = this._generation;

		this._appendMessage({ role: 'user', text: trimmed });
		this._inputEl.value = '';
		this._autosizeInput();
		this._setBusy(true);

		try {
			// Status is bound to this request. A cleared or replaced request keeps
			// streaming on the same connection until the SDK settles it, and a
			// connection-level status line carries nothing to tell it apart from
			// the question the user is actually waiting on.
			const answers = await connection.ask(trimmed, history, (status) => {
				if (this._isCurrentConversation(generation, connection)) {
					this._setThinkingText(status);
				}
			});
			if (!this._isCurrentConversation(generation, connection)) {
				return; // late reply for a cleared transcript or a replaced engine/auth
			}
			const texts = answers.length > 0 ? answers : ['No response received from the pipeline.'];
			for (const answer of texts) {
				this._appendMessage({ role: 'assistant', text: answer });
			}
		} catch (error: unknown) {
			if (!this._isCurrentConversation(generation, connection)) {
				return; // the failure belongs to a conversation the user has left
			}
			const message = error instanceof Error ? error.message : 'Sorry, something went wrong. Please try again.';
			this._appendMessage({ role: 'system', text: message, transient: true });
			this._dispatchError({ message, source: 'chat' });
		} finally {
			// Only the send that still owns the visible conversation may release
			// the composer. An invalidated one must not: clear() and
			// _teardownConnection() already released it, and a newer question may
			// be in flight by now — clearing busy under it would re-enable the
			// composer mid-request and drop the thinking indicator.
			if (this._isCurrentConversation(generation, connection)) {
				this._setBusy(false);
				this._inputEl.focus();
			}
		}
	}

	/**
	 * True while the send that captured `generation` and `connection` still owns
	 * the visible conversation. A reply that loses this race belongs to a
	 * transcript that was cleared, or to an engine/auth context that has since
	 * been replaced, and must not be appended.
	 *
	 * @param generation - `_generation` as it was when the request was sent
	 * @param connection - the connection the request was sent on
	 */
	private _isCurrentConversation(generation: number, connection: WidgetConnection): boolean {
		return this._generation === generation && this._connection === connection;
	}

	/** Conversation history for pipeline context: real user/assistant turns only. */
	private _historyItems(): ChatHistoryItem[] {
		return this._messages.filter((message) => !message.transient && (message.role === 'user' || message.role === 'assistant')).map((message) => ({ role: message.role as 'user' | 'assistant', content: message.text }));
	}

	/** Toggles the pending-reply state: shows or hides the thinking line and re-syncs the composer. */
	private _setBusy(busy: boolean): void {
		this._busy = busy;
		if (busy) {
			this._setThinkingText(DEFAULT_THINKING);
			this._thinkingEl.setAttribute('data-active', '');
		} else {
			this._thinkingEl.removeAttribute('data-active');
			this._thinkingTextEl.textContent = '';
		}
		this._syncComposerState();
		this._autoscroll();
	}

	/** Updates the thinking line with the pipeline's live status text (ignored when not busy). */
	private _setThinkingText(text: string): void {
		if (this._busy) {
			this._thinkingTextEl.textContent = text;
			this._autoscroll();
		}
	}

	/** Enables or disables the input and send button from the busy flag and the connection state. */
	private _syncComposerState(): void {
		// Input is disabled while awaiting a reply; send additionally requires a live connection.
		this._inputEl.disabled = this._busy;
		this._sendEl.disabled = this._busy || this._lastConnectionState !== 'connected';
	}

	// ============================================================================
	// TRANSCRIPT
	// ============================================================================

	/** Renders one message above the thinking line, scrolls if pinned, and emits `rr-message`. */
	private _appendMessage(message: ChatMessage): void {
		this._messages.push(message);

		const el = document.createElement('div');
		el.classList.add('rr-msg', `rr-${message.role}`);
		// Safe by construction: renderMessageHtml escapes all content first.
		el.innerHTML = renderMessageHtml(message.text);
		// Keep the thinking indicator as the last child so it reads below the transcript.
		this._messagesEl.insertBefore(el, this._thinkingEl);

		this._autoscroll();
		this._dispatchMessage({ role: message.role, text: message.text });
	}

	/** Shows the `welcome` attribute as a transient assistant bubble on an empty transcript. */
	private _showWelcome(): void {
		const welcome = this.getAttribute('welcome');
		if (welcome && this._messages.length === 0) {
			this._appendMessage({ role: 'assistant', text: welcome, transient: true });
		}
	}

	/** Updates the welcome bubble live while the conversation hasn't started. */
	private _refreshWelcome(): void {
		const untouched = this._messages.length === 0 || (this._messages.length === 1 && this._messages[0].transient === true && this._messages[0].role === 'assistant');
		if (untouched) {
			this.clear();
		}
	}

	/** Scrolls the transcript to the bottom while the user has not scrolled away from it. */
	private _autoscroll(): void {
		if (this._stickToBottom) {
			this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
		}
	}

	// ============================================================================
	// APPEARANCE
	// ============================================================================

	/** Writes the `title` attribute (or the default) into the header. */
	private _applyTitle(): void {
		this._titleEl.textContent = this.getAttribute('title') || DEFAULT_TITLE;
	}

	/** Sets or clears the `--rr-accent` custom property from the `accent` attribute. */
	private _applyAccent(): void {
		const accent = this.getAttribute('accent');
		if (accent) {
			this._root.style.setProperty('--rr-accent', accent);
		} else {
			this._root.style.removeProperty('--rr-accent');
		}
	}

	/** Writes the `placeholder` attribute (or the default) into the composer input. */
	private _applyPlaceholder(): void {
		this._inputEl.placeholder = this.getAttribute('placeholder') || DEFAULT_PLACEHOLDER;
	}

	/** Resolves 'light' | 'dark' | 'auto' (default) into a concrete data-theme. */
	private _applyTheme(): void {
		const setting = this.getAttribute('theme');
		let effective: 'light' | 'dark';
		if (setting === 'light' || setting === 'dark') {
			effective = setting;
		} else {
			effective = this._prefersDark() ? 'dark' : 'light';
		}
		this._root.setAttribute('data-theme', effective);
	}

	/** True when the browser reports a dark `prefers-color-scheme` (false where matchMedia is unavailable). */
	private _prefersDark(): boolean {
		return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
	}

	/** Subscribes to `prefers-color-scheme` changes so `theme="auto"` updates live. */
	private _watchMedia(): void {
		if (this._mediaQuery || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			return;
		}
		this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		// addEventListener is unavailable on older Safari's MediaQueryList.
		if (typeof this._mediaQuery.addEventListener === 'function') {
			this._mediaQuery.addEventListener('change', this._onMediaChange);
		}
	}

	/** Unsubscribes from the `prefers-color-scheme` listener installed by `_watchMedia`. */
	private _unwatchMedia(): void {
		if (this._mediaQuery && typeof this._mediaQuery.removeEventListener === 'function') {
			this._mediaQuery.removeEventListener('change', this._onMediaChange);
		}
		this._mediaQuery = null;
	}

	/** Grows the textarea with its content up to a 120px cap. */
	private _autosizeInput(): void {
		this._inputEl.style.height = 'auto';
		this._inputEl.style.height = `${Math.min(this._inputEl.scrollHeight, 120)}px`;
	}

	// ============================================================================
	// ERRORS & EVENTS
	// ============================================================================

	/** Reveals the error banner with the given message. */
	private _showError(message: string): void {
		this._errorTextEl.textContent = message;
		this._errorEl.hidden = false;
	}

	/** Hides the error banner. */
	private _hideError(): void {
		this._errorEl.hidden = true;
	}

	/** Emits the composed, bubbling `rr-message` event. */
	private _dispatchMessage(detail: MessageEventDetail): void {
		this.dispatchEvent(new CustomEvent<MessageEventDetail>('rr-message', { detail, bubbles: true, composed: true }));
	}

	/** Emits the composed, bubbling `rr-error` event. */
	private _dispatchError(detail: ErrorEventDetail): void {
		this.dispatchEvent(new CustomEvent<ErrorEventDetail>('rr-error', { detail, bubbles: true, composed: true }));
	}
}

/**
 * Registers the <rocketride-chat> custom element once.
 * Safe to call repeatedly (e.g. when both the ESM and IIFE bundles load).
 */
export function defineRocketRideChat(): void {
	if (typeof customElements !== 'undefined' && !customElements.get(WIDGET_TAG)) {
		customElements.define(WIDGET_TAG, RocketRideChatElement);
	}
}

/** Re-export for consumers that narrow event payloads. */
export type { ChatMessage, ChatRole, ConnectionState, ErrorEventDetail, MessageEventDetail };
