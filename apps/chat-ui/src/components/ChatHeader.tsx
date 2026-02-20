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

import React from 'react';
import { Bot, Settings, Trash2, Palette } from 'lucide-react';
import { useTheme, ThemeName } from '../hooks/useTheme';

interface ChatHeaderProps {
	isConnected: boolean;
	onClearChat: () => void;
}

/**
 * Chat header with connection status and action buttons
 * 
 * Displays:
 * - Bot avatar and title
 * - Connection status (connected/connecting)
 * - Theme selector (standalone mode only)
 * - Clear chat button
 * - Settings button (placeholder)
 * 
 * @param isConnected - Whether WebSocket is connected
 * @param onClearChat - Callback to clear chat history
 */
export const ChatHeader: React.FC<ChatHeaderProps> = ({ isConnected, onClearChat }) => {
	const { mode, currentTheme, setTheme, availableThemes } = useTheme();

	return (
		<div className="chatbot-header">
			<div className="header-content">
				<div className="header-info">
					<div className="bot-avatar">
						<Bot className="w-4 h-4" />
					</div>
					<div className="header-text">
						<h1>RocketRide Assistant</h1>
						<p>
							{isConnected ? 'Connected' : 'Connecting...'}
						</p>
					</div>
				</div>
				<div className="header-actions">
					{/* Theme selector - only show in standalone mode */}
					{mode === 'standalone' && (
						<div className="theme-selector">
							<Palette className="w-4 h-4 theme-selector-icon" />
							<select
								value={currentTheme}
								onChange={(e) => setTheme(e.target.value as ThemeName)}
								className="theme-select"
								title="Select theme"
								aria-label="Select application theme"
							>
								{availableThemes.map(theme => (
									<option key={theme} value={theme}>
										{theme.charAt(0).toUpperCase() + theme.slice(1)}
									</option>
								))}
							</select>
						</div>
					)}
					<button
						onClick={onClearChat}
						className="header-btn"
						title="Clear chat"
						type="button"
						aria-label="Clear chat"
					>
						<Trash2 className="w-5 h-5" />
					</button>
					<button
						className="header-btn"
						title="Settings"
						type="button"
						aria-label="Settings"
					>
						<Settings className="w-5 h-5" />
					</button>
				</div>
			</div>
		</div>
	);
};
