/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
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
import { Mic, MicOff, Send } from 'lucide-react';

interface ChatInputProps {
	onSend: (message: string) => Promise<void>;
	disabled: boolean;
}

/**
 * Chat input component with voice control and send button
 * 
 * Features:
 * - Multi-line text input
 * - Enter to send, Shift+Enter for new line
 * - Voice input button (placeholder for future implementation)
 * - Disabled state when not connected
 * - Auto-focus on mount
 * 
 * @param onSend - Callback function to send message
 * @param disabled - Whether input should be disabled
 */
export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
	const [inputText, setInputText] = useState('');
	const [isListening, setIsListening] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	/**
	 * Focus input on mount for better UX
	 */
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	/**
	 * Handles send button click or Enter key press
	 */
	const handleSend = async () => {
		if (!inputText.trim() || disabled) return;

		await onSend(inputText);
		setInputText('');
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
	};

	/**
	 * Toggles voice input mode (placeholder for future implementation)
	 * 
	 * Currently simulates listening for 3 seconds. Future implementation
	 * would integrate with Web Speech API for actual voice recognition.
	 */
	const toggleVoice = () => {
		setIsListening(!isListening);
		if (!isListening) {
			setTimeout(() => setIsListening(false), 3000);
		}
	};

	return (
		<div className="input-container">
			<div className="input-content">
				<div className="input-wrapper">
					<button
						onClick={toggleVoice}
						className={`voice-btn ${isListening ? 'active' : 'inactive'}`}
						title={isListening ? 'Stop listening' : 'Start voice input'}
						type="button"
					>
						{isListening ? (
							<MicOff className="w-5 h-5" />
						) : (
							<Mic className="w-5 h-5" />
						)}
					</button>

					<div className="input-field-wrapper">
						<textarea
							ref={inputRef}
							value={inputText}
							onChange={(e) => setInputText(e.target.value)}
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

				{isListening && (
					<div className="voice-status">
						<p>🎤 Listening...</p>
					</div>
				)}
			</div>
		</div>
	);
};