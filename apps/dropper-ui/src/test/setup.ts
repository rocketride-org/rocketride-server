/**
 * Vitest setup for chat-ui webview tests.
 *
 * Mocks:
 * - VSCode API (acquireVsCodeApi) — the postMessage bridge
 * - WebSocket — prevents real connections in tests
 * - window.matchMedia — required by some React components
 */
import { vi } from 'vitest';

// Mock VSCode API bridge (injected by VSCode into webviews)
const mockVsCodeApi = {
	postMessage: vi.fn(),
	getState: vi.fn().mockReturnValue({}),
	setState: vi.fn(),
};

// @ts-expect-error -- global mock for VSCode webview environment
globalThis.acquireVsCodeApi = vi.fn().mockReturnValue(mockVsCodeApi);

// Mock WebSocket to prevent real connections
class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	readyState = MockWebSocket.OPEN;
	url: string;

	onopen: ((ev: Event) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		// Auto-trigger onopen after construction
		setTimeout(() => this.onopen?.(new Event('open')), 0);
	}

	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.(new CloseEvent('close'));
	});
	addEventListener = vi.fn();
	removeEventListener = vi.fn();
}

// @ts-expect-error -- global mock
globalThis.WebSocket = MockWebSocket;

// Mock window.matchMedia (used by some UI components)
Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});
