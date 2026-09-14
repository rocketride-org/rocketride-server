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
 * DOM tests for the <rocketride-chat> web component (src/component.ts), run
 * in jsdom with a stubbed SDK client injected through the element's
 * `clientFactory` seam — no live engine, but the real WidgetConnection logic.
 */

import { RocketRideChatElement, WIDGET_TAG } from '../src/component';
import '../src/index'; // registers the custom element (guarded)
import { flush, pressKey } from './helpers';

type SSECallback = (type: string, data: Record<string, unknown>) => Promise<void>;

interface ChatCall {
	token: string;
	question: unknown;
	onSSE?: SSECallback;
}

/**
 * Fake for the structural ChatClientLike interface. Mirrors the SDK's
 * persist-mode behavior: connect() resolves and reports failures through
 * `onConnectError` rather than throwing.
 */
class FakeClient {
	config: Record<string, any> | null = null;
	connectMode: 'ok' | 'fail' = 'ok';
	failureMessage = 'HTTP 401: Authentication error';
	connectCalls = 0;
	chatCalls: ChatCall[] = [];

	private _connected = false;
	// 'any' because the fake fulfils the SDK's PIPELINE_RESULT structurally.
	private _pending: { resolve(result: any): void; reject(error: Error): void } | null = null;

	readonly factory = (config: Record<string, any>): FakeClient => {
		this.config = config;
		return this;
	};

	async connect(): Promise<void> {
		this.connectCalls += 1;
		if (this.connectMode === 'fail') {
			this._connected = false;
			this.config?.onConnectError?.(new Error(this.failureMessage));
			return;
		}
		this._connected = true;
		await this.config?.onConnected?.('connected');
	}

	async disconnect(): Promise<void> {
		this._connected = false;
	}

	isConnected(): boolean {
		return this._connected;
	}

	chat(options: ChatCall): Promise<any> {
		this.chatCalls.push(options);
		return new Promise((resolve, reject) => {
			this._pending = { resolve, reject };
		});
	}

	/** Resolves the pending chat() with a pipeline-shaped result. */
	async resolveChat(answers: string[]): Promise<void> {
		this._pending?.resolve({ result_types: { answers: 'answers' }, answers });
		this._pending = null;
		await flush();
	}

	async rejectChat(message: string): Promise<void> {
		this._pending?.reject(new Error(message));
		this._pending = null;
		await flush();
	}

	/**
	 * Emits a live status ('thinking') line through the onSSE of the chat call
	 * at `index` (default: the most recent). An earlier index emulates a request
	 * that is still streaming after the user moved on from it.
	 */
	async emitStatus(text: string, index = this.chatCalls.length - 1): Promise<void> {
		const call = this.chatCalls[index];
		await call?.onSSE?.('status', { message: text });
		await flush(1);
	}
}

interface Mounted {
	el: RocketRideChatElement;
	client: FakeClient;
	shadow: ShadowRoot;
}

async function createChat(attrs: Record<string, string | null> = {}, client = new FakeClient()): Promise<Mounted> {
	const el = document.createElement(WIDGET_TAG) as RocketRideChatElement;
	el.clientFactory = client.factory;

	const merged: Record<string, string | null> = {
		'engine-url': 'https://engine.test:5565',
		auth: 'TEST-PUBLIC-AUTH-KEY',
		...attrs,
	};
	for (const [name, value] of Object.entries(merged)) {
		if (value !== null) {
			el.setAttribute(name, value);
		}
	}

	document.body.appendChild(el);
	await flush();
	return { el, client, shadow: el.shadowRoot as ShadowRoot };
}

function getInput(shadow: ShadowRoot): HTMLTextAreaElement {
	return shadow.querySelector('.rr-input') as HTMLTextAreaElement;
}

function getSend(shadow: ShadowRoot): HTMLButtonElement {
	return shadow.querySelector('.rr-send') as HTMLButtonElement;
}

function getMessages(shadow: ShadowRoot, role?: 'user' | 'assistant' | 'system'): HTMLElement[] {
	const selector = role ? `.rr-msg.rr-${role}` : '.rr-msg';
	return Array.from(shadow.querySelectorAll<HTMLElement>(selector));
}

function isThinking(shadow: ShadowRoot): boolean {
	return (shadow.querySelector('.rr-thinking') as HTMLElement).hasAttribute('data-active');
}

async function typeAndSubmit(mounted: Mounted, text: string): Promise<void> {
	const input = getInput(mounted.shadow);
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	const form = mounted.shadow.querySelector('.rr-composer') as HTMLFormElement;
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await flush();
}

afterEach(() => {
	document.body.innerHTML = '';
	delete (window as Record<string, any>).__pwned;
});

describe('<rocketride-chat> registration', () => {
	it('defines the custom element with shadow DOM', async () => {
		expect(customElements.get(WIDGET_TAG)).toBe(RocketRideChatElement);
		const { el, shadow } = await createChat();
		expect(el.shadowRoot).not.toBeNull();
		expect(shadow.querySelector('.rr-root')).not.toBeNull();
	});
});

describe('accessibility contract', () => {
	it('exposes the transcript as a polite live log', async () => {
		const { shadow } = await createChat();
		const log = shadow.querySelector('[role="log"]') as HTMLElement;
		expect(log).not.toBeNull();
		expect(log.getAttribute('aria-live')).toBe('polite');
		expect(log.getAttribute('aria-label')).toBeTruthy();
	});

	it('labels the input and the send button', async () => {
		const { shadow } = await createChat();
		expect(getInput(shadow).getAttribute('aria-label')).toBeTruthy();
		expect(getSend(shadow).getAttribute('aria-label')).toBeTruthy();
	});

	it('exposes connection errors as an alert with a Retry action', async () => {
		const client = new FakeClient();
		client.connectMode = 'fail';
		const { shadow } = await createChat({}, client);
		const alert = shadow.querySelector('[role="alert"]') as HTMLElement;
		expect(alert.hidden).toBe(false);
		expect(shadow.querySelector('.rr-retry')).not.toBeNull();
	});
});

describe('connection lifecycle', () => {
	it('connects on mount using engine-url and the public auth key', async () => {
		const { el, client } = await createChat();
		expect(client.connectCalls).toBe(1);
		expect(client.config?.uri).toBe('https://engine.test:5565');
		expect(client.config?.auth).toBe('TEST-PUBLIC-AUTH-KEY');
		expect(client.config?.persist).toBe(true);
		expect(el.connectionState).toBe('connected');
	});

	it('never falls back to ambient env credentials', async () => {
		const { client } = await createChat();
		expect(client.config?.env).toEqual({});
	});

	it('does not connect while engine-url or auth is missing', async () => {
		const { client } = await createChat({ auth: null });
		expect(client.connectCalls).toBe(0);
	});

	it('shows the connecting state until the client reports connected', async () => {
		const client = new FakeClient();
		client.connect = async function (this: FakeClient) {
			this.connectCalls += 1;
			// Never calls onConnected: stays pending server-side.
		};
		const { el, shadow } = await createChat({}, client);
		expect(el.connectionState).toBe('connecting');
		expect(getSend(shadow).disabled).toBe(true);
	});

	it('enters error state with message and recovers via Retry', async () => {
		const client = new FakeClient();
		client.connectMode = 'fail';
		const { el, shadow } = await createChat({}, client);

		expect(el.connectionState).toBe('error');
		const errorText = (shadow.querySelector('.rr-error-text') as HTMLElement).textContent;
		expect(errorText).toContain('HTTP 401');
		expect(getSend(shadow).disabled).toBe(true);

		client.connectMode = 'ok';
		(shadow.querySelector('.rr-retry') as HTMLButtonElement).click();
		await flush();

		expect(el.connectionState).toBe('connected');
		expect((shadow.querySelector('.rr-error') as HTMLElement).hidden).toBe(true);
		expect(getSend(shadow).disabled).toBe(false);
	});

	it('emits rr-error (source: connection) on connection failure', async () => {
		const client = new FakeClient();
		client.connectMode = 'fail';
		const events: unknown[] = [];
		document.body.addEventListener('rr-error', (event) => events.push((event as CustomEvent).detail));
		await createChat({}, client);
		expect(events).toContainEqual({ message: 'HTTP 401: Authentication error', source: 'connection' });
	});
});

describe('message flow', () => {
	it('appends the user message and the assistant answer', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'Hello there');

		expect(getMessages(mounted.shadow, 'user')).toHaveLength(1);
		expect(getMessages(mounted.shadow, 'user')[0].textContent).toContain('Hello there');

		await mounted.client.resolveChat(['Hi! How can I help?']);

		const assistant = getMessages(mounted.shadow, 'assistant');
		expect(assistant).toHaveLength(1);
		expect(assistant[0].textContent).toContain('Hi! How can I help?');
	});

	it('addresses the pipeline with the public auth key as token', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'question');
		expect(mounted.client.chatCalls[0].token).toBe('TEST-PUBLIC-AUTH-KEY');
		await mounted.client.resolveChat(['ok']);
	});

	it('clears and refocuses the input after sending', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'some question');
		expect(getInput(mounted.shadow).value).toBe('');
		await mounted.client.resolveChat(['answer']);
	});

	it('shows the thinking indicator and live status lines while busy', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'crunch this');

		expect(isThinking(mounted.shadow)).toBe(true);
		expect((mounted.shadow.querySelector('.rr-thinking-text') as HTMLElement).textContent).toBeTruthy();

		await mounted.client.emitStatus('Searching the index…');
		expect((mounted.shadow.querySelector('.rr-thinking-text') as HTMLElement).textContent).toBe('Searching the index…');

		await mounted.client.resolveChat(['done']);
		expect(isThinking(mounted.shadow)).toBe(false);
	});

	it('disables the composer while awaiting a reply', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'first');

		expect(getInput(mounted.shadow).disabled).toBe(true);
		expect(getSend(mounted.shadow).disabled).toBe(true);
		expect(mounted.el.busy).toBe(true);

		// A second submit while busy must not reach the pipeline.
		await typeAndSubmit(mounted, 'second');
		expect(mounted.client.chatCalls).toHaveLength(1);

		await mounted.client.resolveChat(['done']);
		expect(getInput(mounted.shadow).disabled).toBe(false);
		expect(getSend(mounted.shadow).disabled).toBe(false);
		expect(mounted.el.busy).toBe(false);
	});

	it('appends one assistant bubble per answer', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'multi');
		await mounted.client.resolveChat(['first answer', 'second answer']);
		expect(getMessages(mounted.shadow, 'assistant')).toHaveLength(2);
	});

	it('replays prior turns as history on the next question', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'first question');
		await mounted.client.resolveChat(['first answer']);
		await typeAndSubmit(mounted, 'second question');

		const payload = JSON.stringify(mounted.client.chatCalls[1].question);
		expect(payload).toContain('first question');
		expect(payload).toContain('first answer');
		await mounted.client.resolveChat(['second answer']);
	});

	it('shows a chat error as a system notice and emits rr-error (source: chat)', async () => {
		const mounted = await createChat();
		const events: unknown[] = [];
		mounted.el.addEventListener('rr-error', (event) => events.push((event as CustomEvent).detail));

		await typeAndSubmit(mounted, 'fails');
		await mounted.client.rejectChat('Pipeline is not running');

		const system = getMessages(mounted.shadow, 'system');
		expect(system.some((el) => el.textContent?.includes('Pipeline is not running'))).toBe(true);
		expect(events).toContainEqual({ message: 'Pipeline is not running', source: 'chat' });
		expect(mounted.el.busy).toBe(false);
	});

	it('guards sends while not connected with a system notice', async () => {
		const mounted = await createChat({ auth: null }); // no connection
		await typeAndSubmit(mounted, 'anyone there?');
		expect(mounted.client.chatCalls).toHaveLength(0);
		expect(getMessages(mounted.shadow, 'system')).not.toHaveLength(0);
	});

	it('emits rr-message for each transcript entry', async () => {
		const mounted = await createChat();
		const details: Array<{ role: string; text: string }> = [];
		mounted.el.addEventListener('rr-message', (event) => details.push((event as CustomEvent).detail));

		await typeAndSubmit(mounted, 'ping');
		await mounted.client.resolveChat(['pong']);

		expect(details).toContainEqual({ role: 'user', text: 'ping' });
		expect(details).toContainEqual({ role: 'assistant', text: 'pong' });
	});
});

describe('keyboard behavior', () => {
	it('Enter sends the message', async () => {
		const mounted = await createChat();
		const input = getInput(mounted.shadow);
		input.value = 'sent with enter';
		const event = pressKey(input, 'Enter');
		await flush();

		expect(event.defaultPrevented).toBe(true);
		expect(mounted.client.chatCalls).toHaveLength(1);
		expect(getMessages(mounted.shadow, 'user')[0].textContent).toContain('sent with enter');
		await mounted.client.resolveChat(['ok']);
	});

	it('Shift+Enter inserts a newline instead of sending', async () => {
		const mounted = await createChat();
		const input = getInput(mounted.shadow);
		input.value = 'line one';
		const event = pressKey(input, 'Enter', { shiftKey: true });
		await flush();

		expect(event.defaultPrevented).toBe(false);
		expect(mounted.client.chatCalls).toHaveLength(0);
		expect(input.value).toBe('line one'); // not cleared: nothing was sent
	});

	it('ignores Enter on empty/whitespace input', async () => {
		const mounted = await createChat();
		const input = getInput(mounted.shadow);
		input.value = '   ';
		pressKey(input, 'Enter');
		await flush();
		expect(mounted.client.chatCalls).toHaveLength(0);
	});
});

describe('output safety in the DOM', () => {
	it('never executes HTML from assistant answers', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'attack me');
		await mounted.client.resolveChat(['<img src=x onerror="window.__pwned=true"><script>window.__pwned=true</script>']);

		expect(mounted.shadow.querySelector('img')).toBeNull();
		expect(mounted.shadow.querySelector('script')).toBeNull();
		expect((window as Record<string, any>).__pwned).toBeUndefined();
		expect(getMessages(mounted.shadow, 'assistant')[0].textContent).toContain('<img src=x onerror=');
	});

	it('never executes HTML from user input', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, '<svg onload="window.__pwned=true">');
		// The only svg in the shadow tree is the trusted send-button icon.
		const svgs = Array.from(mounted.shadow.querySelectorAll('svg'));
		expect(svgs.every((svg) => svg.closest('.rr-send') !== null)).toBe(true);
		expect(mounted.shadow.querySelector('svg[onload]')).toBeNull();
		expect((window as Record<string, any>).__pwned).toBeUndefined();
		await mounted.client.resolveChat(['ok']);
	});
});

describe('conversation invalidation', () => {
	it('drops the transcript when the engine identity changes, so it never reaches the new engine', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'first question');
		await mounted.client.resolveChat(['first answer']);
		expect(getMessages(mounted.shadow, 'user')).toHaveLength(1);

		// Point the widget at a different engine (an auth swap is the same path).
		const next = new FakeClient();
		mounted.el.clientFactory = next.factory;
		mounted.el.setAttribute('engine-url', 'https://other-engine.test:5565');
		await flush();

		expect(mounted.el.messages).toHaveLength(0);
		expect(getMessages(mounted.shadow)).toHaveLength(0);

		await typeAndSubmit(mounted, 'second question');
		const payload = JSON.stringify(next.chatCalls[0].question);
		expect(payload).not.toContain('first question');
		expect(payload).not.toContain('first answer');
		await next.resolveChat(['ok']);
	});

	it('ignores a reply that settles after clear() and frees the composer', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'question');
		expect(mounted.el.busy).toBe(true);

		mounted.el.clear();
		await mounted.client.resolveChat(['late answer']);

		expect(getMessages(mounted.shadow, 'assistant')).toHaveLength(0);
		expect(mounted.el.messages.some((message) => message.text === 'late answer')).toBe(false);
		// The abandoned request must not leave the composer disabled.
		expect(mounted.el.busy).toBe(false);
		expect(getInput(mounted.shadow).disabled).toBe(false);
	});

	it('frees the composer when clear() lands during a pending request', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'first question');
		expect(mounted.el.busy).toBe(true);
		expect(getInput(mounted.shadow).disabled).toBe(true);

		// The first request is still in flight here. clear() has to release the
		// composer straight away instead of waiting for an answer it will drop
		// on arrival — an SDK chat() that never settles would never release it.
		mounted.el.clear();
		expect(mounted.el.busy).toBe(false);
		expect(getInput(mounted.shadow).disabled).toBe(false);
		expect(getSend(mounted.shadow).disabled).toBe(false);
		expect(isThinking(mounted.shadow)).toBe(false);

		// The composer accepts a new message before the old request settles.
		await typeAndSubmit(mounted, 'second question');
		expect(mounted.client.chatCalls).toHaveLength(2);
		expect(mounted.el.busy).toBe(true);

		await mounted.client.resolveChat(['second answer']);
		const assistant = getMessages(mounted.shadow, 'assistant');
		expect(assistant).toHaveLength(1);
		expect(assistant[0].textContent).toContain('second answer');
		expect(mounted.el.busy).toBe(false);
	});

	it('frees the composer when an identity swap abandons a pending request', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'question for the old engine');
		expect(mounted.el.busy).toBe(true);

		// An auth swap runs clear() and then tears the connection down, which
		// abandons the pending ask(): nothing is left waiting on the closed
		// socket, so the composer cannot stay stuck behind it.
		const next = new FakeClient();
		mounted.el.clientFactory = next.factory;
		mounted.el.setAttribute('auth', 'OTHER-PUBLIC-AUTH-KEY');
		await flush();

		expect(mounted.el.busy).toBe(false);
		expect(getInput(mounted.shadow).disabled).toBe(false);
		// The abandoned request left neither a bubble nor an error notice.
		expect(getMessages(mounted.shadow)).toHaveLength(0);

		await typeAndSubmit(mounted, 'question for the new engine');
		expect(next.chatCalls).toHaveLength(1);
		await next.resolveChat(['fresh answer']);
		expect(getMessages(mounted.shadow, 'assistant')[0].textContent).toContain('fresh answer');
		expect(mounted.el.busy).toBe(false);
	});

	it('ignores a status line emitted by a request the user has already cleared', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'first question');

		// clear() frees the composer while the first request is still in flight,
		// so the second question starts on the same connection with the first
		// still streaming underneath it.
		mounted.el.clear();
		await typeAndSubmit(mounted, 'second question');
		expect(mounted.client.chatCalls).toHaveLength(2);

		const thinking = mounted.shadow.querySelector('.rr-thinking-text') as HTMLElement;
		const beforeStaleStatus = thinking.textContent;

		// The abandoned request's status belongs to a transcript that no longer
		// exists; it must not overwrite the indicator of the live question.
		await mounted.client.emitStatus('Still crunching the cleared question…', 0);
		expect(thinking.textContent).toBe(beforeStaleStatus);
		expect(thinking.textContent).not.toContain('cleared question');

		// The live request's own status still gets through.
		await mounted.client.emitStatus('Searching the index…');
		expect(thinking.textContent).toBe('Searching the index…');
	});

	it('ignores a status line from a request whose engine identity was replaced', async () => {
		const mounted = await createChat();
		await typeAndSubmit(mounted, 'question for the old engine');
		const stale = mounted.client;

		const next = new FakeClient();
		mounted.el.clientFactory = next.factory;
		mounted.el.setAttribute('auth', 'OTHER-PUBLIC-AUTH-KEY');
		await flush();

		await typeAndSubmit(mounted, 'question for the new engine');
		const thinking = mounted.shadow.querySelector('.rr-thinking-text') as HTMLElement;
		const beforeStaleStatus = thinking.textContent;

		await stale.emitStatus('Status from the old engine…', 0);
		expect(thinking.textContent).toBe(beforeStaleStatus);

		await next.emitStatus('Status from the new engine…');
		expect(thinking.textContent).toBe('Status from the new engine…');
	});

	it('ignores a failure that settles after the conversation was replaced', async () => {
		const mounted = await createChat();
		const errors: string[] = [];
		mounted.el.addEventListener('rr-error', (event) => {
			errors.push((event as CustomEvent<{ message: string }>).detail.message);
		});

		await typeAndSubmit(mounted, 'question');
		mounted.el.clear();
		await mounted.client.rejectChat('engine exploded');

		expect(getMessages(mounted.shadow, 'system')).toHaveLength(0);
		expect(errors).toHaveLength(0);
		expect(mounted.el.busy).toBe(false);
	});
});

describe('welcome message', () => {
	it('shows the welcome bubble before the first exchange', async () => {
		const mounted = await createChat({ welcome: 'Welcome aboard!' });
		const assistant = getMessages(mounted.shadow, 'assistant');
		expect(assistant).toHaveLength(1);
		expect(assistant[0].textContent).toContain('Welcome aboard!');
	});

	it('excludes the welcome bubble from pipeline history', async () => {
		const mounted = await createChat({ welcome: 'Welcome aboard!' });
		await typeAndSubmit(mounted, 'real question');
		const payload = JSON.stringify(mounted.client.chatCalls[0].question);
		expect(payload).not.toContain('Welcome aboard!');
		await mounted.client.resolveChat(['ok']);
	});
});

describe('autoscroll', () => {
	function fakeScrollMetrics(el: HTMLElement, metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }): void {
		Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true });
		Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true });
		Object.defineProperty(el, 'scrollTop', { value: metrics.scrollTop, writable: true, configurable: true });
	}

	it('sticks to the bottom for new messages by default', async () => {
		const mounted = await createChat();
		const log = mounted.shadow.querySelector('.rr-messages') as HTMLElement;
		fakeScrollMetrics(log, { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 });
		log.dispatchEvent(new Event('scroll'));

		await typeAndSubmit(mounted, 'scroll me');
		expect(log.scrollTop).toBe(1000);
		await mounted.client.resolveChat(['ok']);
	});

	it('respects a user who scrolled up to read history', async () => {
		const mounted = await createChat();
		const log = mounted.shadow.querySelector('.rr-messages') as HTMLElement;
		fakeScrollMetrics(log, { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 });
		log.dispatchEvent(new Event('scroll')); // 1000 - 100 - 300 = 600 > threshold

		await typeAndSubmit(mounted, 'do not scroll');
		expect(log.scrollTop).toBe(100);
		await mounted.client.resolveChat(['ok']);
	});
});

describe('IIFE entry auto-init', () => {
	it('registers the element and mounts the bubble from a data-configured script tag', async () => {
		const script = document.createElement('script');
		script.setAttribute('data-engine-url', 'https://engine.test:5565');
		script.setAttribute('data-auth', 'TEST-PUBLIC-AUTH-KEY');
		script.setAttribute('data-title', 'Entry Test');
		document.body.appendChild(script);

		Object.defineProperty(document, 'currentScript', { value: script, configurable: true });
		try {
			jest.isolateModules(() => {
				require('../src/entry-iife');
			});
		} finally {
			Object.defineProperty(document, 'currentScript', { value: null, configurable: true });
		}

		expect(customElements.get(WIDGET_TAG)).toBeDefined();
		const host = document.querySelector('[data-rocketride-chat-bubble]');
		expect(host).not.toBeNull();
		const chat = host?.shadowRoot?.querySelector(WIDGET_TAG);
		expect(chat?.getAttribute('engine-url')).toBe('https://engine.test:5565');

		// Detach immediately: the upgraded element would otherwise keep a real
		// SDK client retrying against the placeholder URL.
		host?.remove();
		await flush();
	});
});
