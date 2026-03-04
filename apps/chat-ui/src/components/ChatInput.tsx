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

import React, { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';

interface ChatInputProps {
	onSend: (message: string) => Promise<void>;
	disabled: boolean;
}

/**
 * Chat input component with send button
 *
 * Features:
 * - Auto-expanding multi-line text input
 * - Enter to send, Shift+Enter for new line
 * - Clipboard paste support in VSCode webview
 * - Disabled state when not connected
 * - Auto-focus on mount
 * 
 * @param onSend - Callback function to send message
 * @param disabled - Whether input should be disabled
 */
export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
	const [inputText, setInputText] = useState('');
	const inputRef = useRef<HTMLTextAreaElement>(null);

	/**
	 * Focus input on mount and listen for paste messages from VSCode parent
	 */
	useEffect(() => {
		inputRef.current?.focus();

		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type === 'paste' && event.data.text) {
				setInputText(prev => {
					const textarea = inputRef.current;
					if (textarea) {
						const start = textarea.selectionStart;
						const end = textarea.selectionEnd;
						const newValue = prev.slice(0, start) + event.data.text + prev.slice(end);
						// Restore cursor position after React re-render
						requestAnimationFrame(() => {
							textarea.selectionStart = textarea.selectionEnd = start + event.data.text.length;
						});
						return newValue;
					}
					return prev + event.data.text;
				});
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	/**
	 * Handles send button click or Enter key press
	 */
	const handleSend = async () => {
		if (!inputText.trim() || disabled) return;

		const message = inputText;
		setInputText('');
		if (inputRef.current) {
			inputRef.current.style.height = 'auto';
		}
		await onSend(message);
	};

	/**
	 * Handles keyboard input
	 * 
	 * Enter: Send message
	 * Shift+Enter: New line
	 */
	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
		if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
			// In VSCode webview iframes, native paste is blocked.
			// Request clipboard from the parent webview via postMessage.
			if (window.parent !== window) {
				e.preventDefault();
				window.parent.postMessage({ type: 'requestPaste' }, '*');
			}
		}
	};

	return (
		<div className="input-container">
			<div className="input-content">
				<div className="input-wrapper">
					<div className="input-field-wrapper">
						<textarea
							ref={inputRef}
							value={inputText}
							onChange={(e) => {
								setInputText(e.target.value);
								// Auto-resize textarea
								e.target.style.height = 'auto';
								e.target.style.height = `${e.target.scrollHeight}px`;
								// When at max-height and scrolling, force scroll to
								// bottom so the padding below the cursor is visible
								if (e.target.scrollHeight > e.target.clientHeight) {
									e.target.scrollTop = e.target.scrollHeight;
								}
							}}
							onKeyDown={handleKeyDown}
							placeholder={disabled ? "Connecting..." : "Type your message here..."}
							className="input-field"
							rows={1}
							disabled={disabled}
						/>
					</div>

					<button
						onClick={handleSend}
						disabled={!inputText.trim() || disabled}
						className="send-btn"
						title="Send message"
						type="button"
					>
						<Send className="w-5 h-5" />
					</button>
				</div>
			</div>
		</div>
	);
};