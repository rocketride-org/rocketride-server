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
 * Headless smoke tests for the UI-free protocol layer (src/connection.ts).
 *
 * The SDK client is replaced through the injectable ChatClientFactory, so no
 * network or engine server is involved. The fake drives the same config
 * callbacks (onConnected/onDisconnected/onConnectError) the real
 * RocketRideClient would.
 */

import { PIPELINE_RESULT, Question, QuestionType, RocketRideClientConfig } from 'rocketride';
import { ASK_ABANDONED_MESSAGE, HISTORY_LIMIT, WidgetConnection, assertSecureEngineUrl, extractAnswerTexts } from '../src/connection';
import { ChatClientLike, ChatHistoryItem, ConnectionState } from '../src/types';

/** Options captured from a chat() call. */
type ChatOptions = { token: string; question: Question; onSSE?: (type: string, data: Record<string, unknown>) => Promise<void> };

/** Minimal fake SDK client driving the config callbacks like the real one. */
class FakeClient implements ChatClientLike {
	connected = false;
	chatCalls: ChatOptions[] = [];
	result: PIPELINE_RESULT = { name: '', path: '', objectId: '' };

	constructor(private readonly config: RocketRideClientConfig) {}

	async connect(): Promise<unknown> {
		this.connected = true;
		await this.config.onConnected?.('connected');
		return {};
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		await this.config.onDisconnected?.('closed', false);
	}

	isConnected(): boolean {
		return this.connected;
	}

	async chat(options: ChatOptions): Promise<PIPELINE_RESULT> {
		this.chatCalls.push(options);
		await options.onSSE?.('status', { message: 'Searching documents…' });
		await options.onSSE?.('status', { noMessageHere: true });
		return this.result;
	}
}

/** Builds a connection wired to a FakeClient, capturing states and statuses. */
function makeConnection() {
	const states: Array<{ state: ConnectionState; detail?: string }> = [];
	const statuses: string[] = [];
	let client: FakeClient | null = null;
	let config: RocketRideClientConfig | null = null;

	const connection = new WidgetConnection({
		engineUrl: 'http://localhost:5565',
		auth: 'PUBLIC-AUTH-KEY-PLACEHOLDER',
		onStateChange: (state, detail) => states.push({ state, detail }),
		onStatus: (text) => statuses.push(text),
		createClient: (clientConfig) => {
			config = clientConfig;
			client = new FakeClient(clientConfig);
			return client;
		},
	});

	return { connection, states, statuses, getClient: () => client, getConfig: () => config };
}

describe('WidgetConnection — connect/disconnect lifecycle', () => {
	it('configures the SDK with the public auth key only and reports state transitions', async () => {
		const { connection, states, getConfig } = makeConnection();

		expect(connection.state).toBe('idle');
		await connection.connect();

		const config = getConfig();
		expect(config).not.toBeNull();
		expect(config!.auth).toBe('PUBLIC-AUTH-KEY-PLACEHOLDER');
		expect(config!.uri).toBe('http://localhost:5565');
		expect(config!.persist).toBe(true);
		// No ambient env fallback (e.g. ROCKETRIDE_APIKEY) may ever be picked up.
		expect(config!.env).toEqual({});

		expect(states.map((s) => s.state)).toEqual(['connecting', 'connected']);
		expect(connection.isConnected()).toBe(true);

		await connection.disconnect();
		// The manual disconnect is not reported as a drop; final state is 'idle'.
		expect(states.map((s) => s.state)).toEqual(['connecting', 'connected', 'idle']);
		expect(connection.state).toBe('idle');
	});

	it('rejects a missing configuration and surfaces connection errors', async () => {
		const bare = new WidgetConnection({ engineUrl: '', auth: '' });
		await expect(bare.connect()).rejects.toThrow(/engineUrl and auth/);

		const { connection, states, getConfig } = makeConnection();
		await connection.connect();
		// Simulate an SDK-reported drop with error (e.g. HTTP 401 on reconnect).
		await getConfig()!.onDisconnected?.('Authentication error', true);
		expect(states[states.length - 1]).toEqual({ state: 'error', detail: 'Authentication error' });
	});
});

describe('WidgetConnection — transport security', () => {
	/** Builds a connection for `engineUrl`, tracking whether a client was ever built. */
	function makeFor(engineUrl: string) {
		let created = 0;
		const connection = new WidgetConnection({
			engineUrl,
			auth: 'PUBLIC-AUTH-KEY-PLACEHOLDER',
			createClient: (clientConfig) => {
				created += 1;
				return new FakeClient(clientConfig);
			},
		});
		return { connection, clientsCreated: () => created };
	}

	// TLS, or a host the traffic never leaves the machine to reach.
	it.each(['https://engine.example.com', 'wss://engine.example.com', 'http://localhost:5565', 'http://127.0.0.1:5565', 'http://127.1.2.3:5565', 'http://[::1]:5565', 'http://engine.localhost:5565', 'ws://localhost:5565'])('accepts %s', (engineUrl: string) => {
		expect(() => assertSecureEngineUrl(engineUrl)).not.toThrow();
	});

	// Cleartext to a host that is reached over the network: the auth key and
	// every message would be readable on the wire.
	it.each(['http://engine.example.com', 'http://engine.example.com:5565', 'ws://engine.example.com', 'http://10.0.0.5:5565', 'http://192.168.1.10:5565', 'engine.example.com:5565'])('rejects cleartext %s', (engineUrl: string) => {
		expect(() => assertSecureEngineUrl(engineUrl)).toThrow(/cleartext/);
	});

	it('rejects an unsupported scheme and an unparseable URL', () => {
		expect(() => assertSecureEngineUrl('ftp://engine.example.com')).toThrow(/unsupported engineUrl scheme/);
		expect(() => assertSecureEngineUrl('http://')).toThrow(/not a valid URL/);
	});

	it('never builds a client for a cleartext engine URL', async () => {
		const { connection, clientsCreated } = makeFor('http://engine.example.com:5565');

		await expect(connection.connect()).rejects.toThrow(/cleartext/);
		// Nothing was constructed, so the auth key never reached a transport.
		expect(clientsCreated()).toBe(0);
		expect(connection.isConnected()).toBe(false);
		expect(connection.state).toBe('idle');
	});

	it('still builds a client for a loopback development URL', async () => {
		const { connection, clientsCreated } = makeFor('http://localhost:5565');

		await connection.connect();
		expect(clientsCreated()).toBe(1);
		expect(connection.isConnected()).toBe(true);
	});
});

describe('WidgetConnection — ask()', () => {
	it('sends a PROMPT question with capped history and maps SSE statuses to onStatus', async () => {
		const { connection, statuses, getClient } = makeConnection();
		await connection.connect();

		const client = getClient()!;
		client.result = { name: '', path: '', objectId: '', result_types: { answers: 'answers' }, answers: ['First answer', 'Second answer'] };

		const history: ChatHistoryItem[] = Array.from({ length: HISTORY_LIMIT + 2 }, (_item, index) => ({
			role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
			content: `turn ${index}`,
		}));

		const answers = await connection.ask('What is RocketRide?', history);

		expect(answers).toEqual(['First answer', 'Second answer']);
		expect(client.chatCalls).toHaveLength(1);
		const options = client.chatCalls[0];
		// The pipeline is addressed with the same public auth key.
		expect(options.token).toBe('PUBLIC-AUTH-KEY-PLACEHOLDER');
		expect(options.question).toBeInstanceOf(Question);
		expect(options.question.type).toBe(QuestionType.PROMPT);
		expect(options.question.questions).toHaveLength(1);
		// History is capped to the most recent HISTORY_LIMIT entries.
		expect(options.question.history).toHaveLength(HISTORY_LIMIT);
		expect(options.question.history[0].content).toBe('turn 2');
		// Only SSE payloads carrying a message string reach onStatus.
		expect(statuses).toEqual(['Searching documents…']);
	});

	it('routes SSE statuses to the per-request callback instead of the connection-level one', async () => {
		const { connection, statuses, getClient } = makeConnection();
		await connection.connect();
		getClient()!.result = { name: '', path: '', objectId: '', result_types: { answers: 'answers' }, answers: ['Answer'] };

		const perRequest: string[] = [];
		await connection.ask('What is RocketRide?', [], (status) => perRequest.push(status));

		// A caller that asks for its own status owns every line of that request,
		// so nothing leaks to the connection-level fallback where it could be
		// mistaken for the status of a different, still-live request.
		expect(perRequest).toEqual(['Searching documents…']);
		expect(statuses).toEqual([]);
	});

	it('fails when the connection was never opened', async () => {
		const { connection } = makeConnection();
		await expect(connection.ask('hello')).rejects.toThrow(/connect\(\) first/);
	});
});

describe('WidgetConnection — abandoning in-flight asks', () => {
	it('rejects a pending ask() when disconnect() closes the transport under it', async () => {
		// Holder (not a bare `let`): TypeScript does not track an assignment made
		// inside the executor callback below.
		const pendingChat: { settle?: (result: PIPELINE_RESULT) => void } = {};
		const connection = new WidgetConnection({
			engineUrl: 'http://localhost:5565',
			auth: 'PUBLIC-AUTH-KEY-PLACEHOLDER',
			createClient: (config) => {
				const client = new FakeClient(config);
				// A chat() that never settles by itself: the real SDK promise is
				// bound to the socket disconnect() is about to close.
				client.chat = () =>
					new Promise<PIPELINE_RESULT>((resolve) => {
						pendingChat.settle = resolve;
					});
				return client;
			},
		});

		await connection.connect();
		const pending = connection.ask('never answered');

		await connection.disconnect();
		await expect(pending).rejects.toThrow(ASK_ABANDONED_MESSAGE);

		// A late settlement of the underlying SDK call is discarded silently.
		pendingChat.settle?.({ name: '', path: '', objectId: '' });
	});
});

describe('extractAnswerTexts', () => {
	it('extracts strings, arrays and { answer } objects from typed fields only', () => {
		const result: PIPELINE_RESULT = {
			name: '',
			path: '',
			objectId: '',
			result_types: { plain: 'text', list: 'answers', wrapped: 'answers', skipped: 'metadata' },
			plain: 'a plain answer',
			list: ['one', '   ', 'two'],
			wrapped: { answer: '  wrapped answer  ', expectJson: false },
			skipped: 'must not appear',
		};
		expect(extractAnswerTexts(result)).toEqual(['a plain answer', 'one', 'two', 'wrapped answer']);
	});

	it('returns an empty list when result_types is missing', () => {
		expect(extractAnswerTexts({ name: '', path: '', objectId: '' })).toEqual([]);
	});
});
