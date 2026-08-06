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
// CHAT VIEW — LAZY GALLERY DEMO
// =============================================================================

/**
 * Lazily-loaded ChatView demo: the chat module drags markdown rendering in,
 * so the gallery loads it only when the ChatView entry is first viewed.
 * Messages are canned; sending appends locally and canned-replies after a
 * beat so the typing indicator shows.
 */

import React, { useRef, useState } from 'react';
import { ChatView } from '../../../../../modules/chat';
import type { ChatMessage } from '../../../../../modules/chat';
import type { IGalleryDemoProps } from '../../galleryTypes';

/** The canned conversation seed. */
const SEED_MESSAGES: ChatMessage[] = [
	{ id: 1, text: 'What did the last ingest run process?', sender: 'user', timestamp: '09:12' },
	{ id: 2, text: 'The last run processed **1,284 documents** in 14 seconds - 3 were skipped as duplicates.', sender: 'bot', timestamp: '09:12', meta: '2,340 tokens - 1.8s' },
];

/** Live demo: a self-contained ChatView with local message state. */
const ChatViewDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [messages, setMessages] = useState<ChatMessage[]>(SEED_MESSAGES);
	const [isTyping, setIsTyping] = useState(false);
	// Monotonic id source continuing after the seed messages
	const nextId = useRef(SEED_MESSAGES.length + 1);

	/** Appends the user message, then a canned bot reply after a beat. */
	const handleSend = (text: string): void => {
		const stamp = new Date().toTimeString().slice(0, 5);
		setMessages((prev) => [...prev, { id: nextId.current++, text, sender: 'user', timestamp: stamp }]);
		setIsTyping(true);
		setTimeout(() => {
			setMessages((prev) => [...prev, { id: nextId.current++, text: 'This is a canned gallery reply - no pipeline behind it.', sender: 'bot', timestamp: stamp }]);
			setIsTyping(false);
		}, 900);
	};

	return (
		<div style={{ height: 380, display: 'flex', flexDirection: 'column' }}>
			<ChatView
				messages={messages}
				isTyping={isTyping || Boolean(knobs.typing)}
				isConnected={Boolean(knobs.connected)}
				onSend={handleSend}
				placeholder="Ask about your documents..."
			/>
		</div>
	);
};

export default ChatViewDemo;
