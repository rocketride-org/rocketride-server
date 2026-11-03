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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import React, { useEffect, useRef, CSSProperties } from 'react';
import { MessageData } from './SettingsWebview';

// ============================================================================
// TYPES
// ============================================================================

interface MessageDisplayProps {
	message: MessageData | null;
	/** When true, renders as an inline message inside a section (no margin-bottom, display:block) */
	inline?: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MESSAGE_LEVEL_STYLES: Record<string, CSSProperties> = {
	success: {
		backgroundColor: 'var(--vscode-testing-iconPassed)',
		color: 'var(--rr-bg-default)',
	},
	error: {
		backgroundColor: 'var(--vscode-inputValidation-errorBackground)',
		color: 'var(--vscode-inputValidation-errorForeground)',
		border: '1px solid var(--vscode-inputValidation-errorBorder)',
	},
	info: {
		backgroundColor: 'var(--vscode-inputValidation-infoBackground)',
		color: 'var(--vscode-inputValidation-infoForeground)',
		border: '1px solid var(--vscode-inputValidation-infoBorder)',
	},
	warning: {
		backgroundColor: 'var(--vscode-inputValidation-warningBackground)',
		color: 'var(--vscode-inputValidation-warningForeground)',
		border: '1px solid var(--vscode-inputValidation-warningBorder)',
	},
};

// ============================================================================
// COMPONENT
// ============================================================================

export const MessageDisplay: React.FC<MessageDisplayProps> = ({ message, inline }) => {
	const messageRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (message && messageRef.current) {
			// Scroll message into view
			messageRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	}, [message]);

	if (!message) {
		return <div style={{ display: 'none' }} />;
	}

	const levelStyle = MESSAGE_LEVEL_STYLES[message.level] || {};

	return (
		<div
			ref={messageRef}
			style={{
				padding: '12px 16px',
				borderRadius: 4,
				marginBottom: inline ? 0 : 20,
				fontSize: 13,
				display: 'block',
				...(inline ? { gridColumn: '1 / -1', marginTop: 4 } : {}),
				...levelStyle,
			}}
		>
			{message.message}
		</div>
	);
};
