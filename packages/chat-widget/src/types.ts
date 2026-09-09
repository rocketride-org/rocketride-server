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
 * Shared types for the RocketRide chat widget.
 *
 * @module types
 */

import type { PIPELINE_RESULT, Question, RocketRideClientConfig } from 'rocketride';

/** Role of a chat transcript entry. */
export type ChatRole = 'user' | 'assistant' | 'system';

/** One entry in the widget's transcript. */
export interface ChatMessage {
	/** Who authored the entry. */
	role: ChatRole;
	/** Plain-text content (rendered through the widget's safe formatter, never as raw HTML). */
	text: string;
	/**
	 * True for UI-only entries (welcome text, error notices) that must never be
	 * replayed to the pipeline as conversation history.
	 */
	transient?: boolean;
}

/** A conversation history item sent to the pipeline for context. */
export interface ChatHistoryItem {
	role: 'user' | 'assistant';
	content: string;
}

/** Connection lifecycle states surfaced to the widget UI. */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

/** Detail payload of the widget's 'rr-message' CustomEvent. */
export interface MessageEventDetail {
	role: ChatRole;
	text: string;
}

/** Detail payload of the widget's 'rr-error' CustomEvent. */
export interface ErrorEventDetail {
	message: string;
	/** Whether the error came from the connection lifecycle or a chat request. */
	source: 'connection' | 'chat';
}

/** Value of the widget's `theme` attribute. 'auto' follows prefers-color-scheme. */
export type ThemeSetting = 'light' | 'dark' | 'auto';

/**
 * Structural subset of the RocketRide SDK client used by the widget.
 *
 * The real {@link RocketRideClient} satisfies this interface; unit tests can
 * inject a lightweight stub instead (see {@link ChatClientFactory}).
 */
export interface ChatClientLike {
	/** Open the WebSocket and authenticate with the configured credential. */
	connect(): Promise<unknown>;
	/** Close the connection and stop any automatic reconnection. */
	disconnect(): Promise<void>;
	/** True when the transport is currently connected. */
	isConnected(): boolean;
	/**
	 * Run one chat turn through the pipeline identified by `token`.
	 * The real client resolves with a {@link PIPELINE_RESULT}; the return type
	 * is declared `unknown` so lightweight test doubles qualify structurally
	 * (the widget narrows the result defensively either way).
	 */
	chat(options: { token: string; question: Question; onSSE?: (type: string, data: Record<string, unknown>) => Promise<void> }): Promise<PIPELINE_RESULT | unknown>;
}

/**
 * Factory that creates the underlying SDK client from a prepared config.
 * Injectable so `WidgetConnection` can be unit-tested headlessly.
 */
export type ChatClientFactory = (config: RocketRideClientConfig) => ChatClientLike;
