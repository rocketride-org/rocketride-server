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
// CHAT VIEW — GALLERY ENTRY (LAZY)
// =============================================================================

/** Gallery entry for ChatView - the markdown stack loads on first view. */

import type { IGalleryEntry } from '../galleryTypes';

/** The ChatView gallery entry. */
export const chatViewEntry: IGalleryEntry = {
	id: 'chat-view',
	name: 'ChatView',
	group: 'content',
	blurb: 'The single chat implementation, everywhere: message thread + input sharing one centered column (720px cap), markdown rendering, typing indicator, and in-thread error banners. Type in the live demo - replies are canned.',
	knobs: [
		{ id: 'connected', label: 'Connected', kind: 'boolean', defaultValue: true },
		{ id: 'typing', label: 'Force typing', kind: 'boolean', defaultValue: false },
	],
	doc: `ChatView is part of the shell surface: apps import it (with \`useChatMessages\`) from \`shell\`. The host owns the message state and the transport; ChatView only renders and collects input.`,
	lazyDemo: () => import('./demos/ChatViewDemo'),
	code: `import { ChatView, useChatMessages } from 'shell';

const { messages, isTyping, sendMessage } = useChatMessages({ welcomeMessage: 'Hi - ask me anything.' });

<ChatView
	messages={messages}
	isTyping={isTyping}
	isConnected={isConnected}
	onSend={(text) => void sendMessage(text, client, authToken)}
	placeholder="Ask about your documents..."
/>`,
	props: [
		{ name: 'messages', type: 'ChatMessage[]', dir: 'in', required: true, note: 'Current message list, managed by the host via useChatMessages.' },
		{ name: 'isTyping', type: 'boolean', dir: 'in', required: true, note: 'Whether the assistant is currently composing a response.' },
		{ name: 'isConnected', type: 'boolean', dir: 'in', required: true, note: 'Whether the underlying client is connected (gates the input).' },
		{ name: 'placeholder', type: 'string', dir: 'in', note: 'Input placeholder when idle. Defaults to "Ask anything...".' },
		{ name: 'emptyTitle', type: 'string', dir: 'in', note: 'EmptyState title when the conversation has no messages.' },
		{ name: 'emptyDescription', type: 'string', dir: 'in', note: 'EmptyState description when the conversation has no messages.' },
		{ name: 'leadingInputSlot', type: 'ReactNode', dir: 'in', note: 'Optional node rendered before the input field (reserved for attachments).' },
		{ name: 'onSend', type: '(text: string) => void', dir: 'out', required: true, note: 'Called when the user submits a message.' },
	],
};
