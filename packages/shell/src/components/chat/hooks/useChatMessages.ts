// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Question, QuestionType, type PIPELINE_RESULT } from 'rocketride';
import type { ChatMessage, ChatTurnView, TextResult, UseChatMessagesOptions } from '../types';
import { TurnController, type ChatRequest } from '../turns/turnController';

// =============================================================================
// extractTextFromResult
// =============================================================================

/**
 * Extracts displayable text responses from a RocketRide pipeline result.
 * Handles the dynamic field system where result_types maps field names to types.
 */
function extractTextFromResult(result: PIPELINE_RESULT): TextResult[] {
	const out: TextResult[] = [];

	if (!result.result_types) {
		out.push({ text: '### No answers found\nAre you sure your pipeline returns them?', key: '' });
		return out;
	}

	for (const [field, type] of Object.entries(result.result_types)) {
		if (type !== 'text' && type !== 'answers') continue;
		const data = result[field];

		if (Array.isArray(data)) {
			data.filter((v) => typeof v === 'string' && v.trim()).forEach((v) => out.push({ text: v, key: field }));
		} else if (typeof data === 'string' && data.trim()) {
			out.push({ text: data, key: field });
		} else if (data !== null && typeof data === 'object' && typeof (data as Record<string, unknown>).answer === 'string') {
			const text = ((data as Record<string, unknown>).answer as string).trim();
			if (text) out.push({ text, key: field });
		}
	}

	return out;
}

// =============================================================================
// BUILT-IN REQUEST
// =============================================================================

/** The client and token the latest sendMessage call passed. */
type Transport = { client: any; authToken: string };

/**
 * The built-in chat call, used when the host injects no `request`. It does not race the turn's signal: the
 * stop grace closes a stopped built-in turn.
 */
function builtInRequest(transport: { current: Transport }): ChatRequest {
	return async (text, onStatus, turn) => {
		const { client, authToken } = transport.current;
		if (!client || !authToken) throw new Error('Not connected. Please refresh the page.');

		const question = new Question({ type: QuestionType.PROMPT, expectJson: false });
		question.addQuestion(text);
		[...turn.history.filter((m) => m.sender !== 'system' && m.sender !== 'status').map((m) => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.text })), { role: 'user', content: text }].slice(-6).forEach((entry) => question.addHistory(entry));

		const result: PIPELINE_RESULT = await client.chat({
			token: authToken,
			question,
			onSSE: async (type: string, data: Record<string, unknown>) => {
				if (typeof data.message === 'string') onStatus(type, data.message);
			},
		});

		const responses = extractTextFromResult(result);
		return responses.length > 0 ? responses : [{ text: 'No valid response received', key: '' }];
	};
}

// =============================================================================
// useChatMessages
// =============================================================================

export interface UseChatMessagesReturn {
	messages: ChatMessage[];
	isTyping: boolean;
	sendMessage: (text: string, client: any, authToken: string) => Promise<void>;
	clearMessages: () => void;
	addSystemMessage: (text: string) => void;
	/** Turn controls for ChatView's `turn` prop: Stop, Edit and Remove on queued messages, and the running turn's waiting cards. */
	turn: ChatTurnView;
	/**
	 * The chat this hook drives: the `controller` passed in, or the one the hook made. A caller that
	 * keeps it and passes it back as `controller` keeps the chat, and its running turn, past this
	 * component's unmount.
	 */
	controller: TurnController;
}

/**
 * Manages one chat's transcript and its single turn, over a TurnController.
 * One turn runs at a time: a send during a turn adds a queued message, which
 * the running request may take and which otherwise runs next. Unmounting
 * stops a running turn of a controller the hook made; a controller the
 * caller passes in (`controller`) is the caller's, and only the caller stops it.
 */
export function useChatMessages(options: UseChatMessagesOptions = {}): UseChatMessagesReturn {
	const latest = useRef(options);
	latest.current = options;
	const transport = useRef<Transport>({ client: null, authToken: '' });
	const own = useRef<TurnController | null>(null);
	const controller = options.controller ?? (own.current ??= new TurnController({ initialMessages: options.initialMessages, request: () => latest.current.request ?? builtInRequest(transport) }));
	const snap = useSyncExternalStore(controller.subscribe, controller.snapshot);

	// step: unmounting stops a running turn (closing a plain chat's tab), so no run goes on that nobody sees.
	// Not when the latest render passed a controller, even the one the hook made: that chat outlives this
	// component. StrictMode's dev unmount runs this too, so it must never stop a passed one.
	useEffect(
		() => () => {
			if (!latest.current.controller) own.current?.stop();
		},
		[]
	);

	const sendMessage = useCallback(
		async (text: string, client: any, authToken: string) => {
			transport.current = { client, authToken };
			controller.send(text);
		},
		[controller]
	);
	const clearMessages = useCallback(() => controller.clear(latest.current.welcomeMessage ?? 'Chat cleared. How can I help you?'), [controller]);
	const addSystemMessage = useCallback((text: string) => controller.addSystemMessage(text), [controller]);
	const turn = useMemo<ChatTurnView>(
		() => ({
			phase: snap.phase,
			returned: snap.returned,
			stop: () => controller.stop(),
			editQueued: (id) => controller.editQueued(id),
			removeQueued: (id) => controller.removeQueued(id),
			asks: snap.asks,
			answerAsk: (id, answer) => controller.answerAsk(id, answer),
			draft: controller.draft,
		}),
		[controller, snap.phase, snap.returned, snap.asks]
	);
	return { messages: snap.messages, isTyping: snap.phase !== 'idle', sendMessage, clearMessages, addSystemMessage, turn, controller };
}
