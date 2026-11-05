// =============================================================================
// MIT License
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
// VECTOR-UI — useVectorChat (the console's chat over the documents)
// =============================================================================
//
// The shell's chat hook takes a raw token and keeps only the answer text; the
// console needs the cited chunks too and must never hold a token, so it has
// its own: the connection's chat session (chatSession.ts, kept per connection
// in registry.ts) asks through the shared library's chat role channel, which
// holds the token. Questions are SDK `Question`s built from the 'rocketride'
// singleton, optionally restricted to chosen documents.
// =============================================================================

import { useCallback, useSyncExternalStore } from 'react';
import { Question } from 'rocketride';
import { ExplorerToolError } from 'shared/explorer';
import type { ChatPanelProps } from '../contract/types';
import { chatSessionFor } from './registry';
import type { ChatDeps, ChatState, ChatTurn } from './chatSession';

/** What the chat panel gets from the hook. */
export interface VectorChat {
	state: ChatState;
	send(text: string): void;
	stopWaiting(): void;
	clear(): void;
	history(): string[];
}

/**
 * Build the SDK question for a text (restricted to `scope` when given).
 *
 * @param text - The question.
 * @param scope - objectIds to search in, or null for the whole collection.
 * @returns The Question.
 */
export function buildQuestion(text: string, scope: readonly string[] | null): Question {
	const question = new Question();
	question.addQuestion(text);
	if (scope !== null && scope.length > 0) question.filter = { ...question.filter, objectIds: [...scope] };
	return question;
}

/**
 * The connection's chat.
 *
 * @param props - The chat panel's props.
 * @returns State and actions.
 */
export function useVectorChat(props: Pick<ChatPanelProps, 'model' | 'channels' | 'selection' | 'actions' | 'scope'>): VectorChat {
	const { model, channels, selection, actions, scope } = props;
	const deps: ChatDeps = {
		ask: (question, options) => {
			const chat = channels.chat;
			if (chat === null) return Promise.reject(new ExplorerToolError({ kind: 'unavailable', tool: 'chat', message: 'This pipeline has no running Chat source.' }));
			return chat.ask(question, options);
		},
		makeQuestion: buildQuestion,
		now: () => Date.now(),
		onAnswer: (turn: ChatTurn) => {
			const keys = turn.answer?.sources.map((source) => source.key) ?? [];
			if (keys.length > 0) selection.setHighlight({ source: 'chat', keys });
		},
		announce: (message) => actions.announce(message),
	};
	const session = chatSessionFor(model.connectionKey, deps);
	const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
	const send = useCallback((text: string) => void session.send(text, scope), [session, scope]);
	return { state, send, stopWaiting: session.stopWaiting, clear: session.clear, history: session.history };
}
