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
import { Send, Paperclip, X } from 'lucide-react';
import type { Attachment } from '../types/Attachment';
import { uploadAttachment, type UploadClient } from '../utils/uploadAttachment';

interface ChatInputProps {
	/**
	 * Send the user's message. The `attachments` arg is optional for
	 * backwards compatibility with parents that have not yet been updated
	 * to forward attachments (activation-gated).
	 */
	onSend: (message: string, attachments?: Attachment[]) => Promise<void>;
	disabled: boolean;
	/**
	 * RocketRide client used to upload attachments via the chunked filestore
	 * protocol. Optional — when undefined the 📎 button is hidden so the
	 * component stays usable in non-persistent / legacy contexts.
	 */
	client?: UploadClient;
	/**
	 * Current chat id. Required for upload path construction; when missing,
	 * the 📎 button is hidden.
	 */
	chatId?: string;
}

/**
 * Chat input component with send button and optional file attachments.
 *
 * Features:
 * - Auto-expanding multi-line text input
 * - Enter to send, Shift+Enter for new line
 * - Clipboard paste support in VSCode webview
 * - Disabled state when not connected
 * - Auto-focus on mount
 * - 📎 attach files (when `client` + `chatId` are provided) with chunked
 *   upload; attachment pills render above the textarea while pending
 */
export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled, client, chatId }) => {
	const [inputText, setInputText] = useState('');
	const [pending, setPending] = useState<Attachment[]>([]);
	const [uploading, setUploading] = useState<number>(0);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const attachEnabled = !!client && !!chatId;

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
	 * Upload selected files in parallel via the chunked filestore helper.
	 * Each successful upload pushes a pill onto the pending list; failures
	 * are surfaced via `console.error` and skipped (the user can retry).
	 */
	const handleFiles = async (files: FileList) => {
		if (!client || !chatId) return;
		const list = Array.from(files);
		setUploading(n => n + list.length);
		try {
			const results = await Promise.allSettled(
				list.map(file => uploadAttachment({ client, chatId, file }))
			);
			const uploaded: Attachment[] = [];
			for (const r of results) {
				if (r.status === 'fulfilled') uploaded.push(r.value);
				else console.error('[chat-ui] attachment upload failed:', r.reason);
			}
			if (uploaded.length) setPending(prev => [...prev, ...uploaded]);
		} finally {
			setUploading(n => n - list.length);
		}
	};

	const removePending = (id: string) => {
		setPending(prev => prev.filter(a => a.attachment_id !== id));
	};

	/**
	 * Handles send button click or Enter key press
	 */
	const handleSend = async () => {
		if (disabled) return;
		if (!inputText.trim() && pending.length === 0) return;
		if (uploading > 0) return;

		const message = inputText;
		const atts = pending;
		setInputText('');
		setPending([]);
		if (inputRef.current) {
			inputRef.current.style.height = 'auto';
		}
		await onSend(message, atts);
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
				{(pending.length > 0 || uploading > 0) && (
					<div className="attachment-pills attachment-pills--input">
						{pending.map(a => (
							<span key={a.attachment_id} className="attachment-pill" title={`${a.mime} · ${a.size_bytes} bytes`}>
								<span className="attachment-pill-name">{a.filename}</span>
								<button
									type="button"
									className="attachment-pill-remove"
									onClick={() => removePending(a.attachment_id)}
									title="Remove attachment"
								>
									<X className="w-3 h-3" />
								</button>
							</span>
						))}
						{uploading > 0 && (
							<span className="attachment-pill attachment-pill--uploading">
								Uploading {uploading}…
							</span>
						)}
					</div>
				)}
				<div className="input-wrapper">
					{attachEnabled && (
						<>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								style={{ display: 'none' }}
								onChange={(e) => {
									if (e.target.files && e.target.files.length > 0) {
										handleFiles(e.target.files);
									}
									// Reset so selecting the same file again re-fires onChange.
									e.target.value = '';
								}}
								disabled={disabled}
							/>
							<button
								type="button"
								className="attach-btn"
								title="Attach file"
								onClick={() => fileInputRef.current?.click()}
								disabled={disabled}
							>
								<Paperclip className="w-5 h-5" />
							</button>
						</>
					)}
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
						disabled={disabled || uploading > 0 || (!inputText.trim() && pending.length === 0)}
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
