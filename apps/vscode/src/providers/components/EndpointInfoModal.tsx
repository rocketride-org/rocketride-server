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

import React, { useState } from 'react';

/**
 * Endpoint Configuration Modal Component
 * 
 * Displays endpoint configuration details including URL and authentication key
 * with copy, open, and show/hide functionality.
 */

export interface EndpointInfo {
	'button-text'?: string;  // e.g., "Chat now", "Open Dropper" (optional for webhook)
	'button-link'?: string;  // URL to open (optional for webhook)
	'url-text': string;      // e.g., "Chat interface URL", "Webhook Endpoint"
	'url-link': string;      // The actual URL
	'auth-text': string;     // e.g., "Public Authorization Key", "Secret Key"
	'auth-key': string;      // The actual key
	'token-text'?: string;   // e.g., "Private Token" (optional)
	'token-key'?: string;    // The actual token (optional)
}

interface EndpointInfoModalProps {
	/** Endpoint configuration data */
	endpointInfo: EndpointInfo | null;
	/** Whether the modal is open */
	isOpen: boolean;
	/** Handler to close the modal */
	onClose: () => void;
	/** Handler to open external URLs */
	onOpenExternal: (url: string) => void;
	/** Host to replace {host} placeholders */
	host: string;
}

export const EndpointInfoModal: React.FC<EndpointInfoModalProps> = ({
	endpointInfo,
	isOpen,
	onClose,
	onOpenExternal,
	host
}) => {
	const [isKeyVisible, setIsKeyVisible] = useState(false);
	const [isTokenVisible, setIsTokenVisible] = useState(false);
	const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

	// Use ref to store onClose and avoid closure issues
	const onCloseRef = React.useRef(onClose);

	// Update ref synchronously during render (not in useEffect)
	onCloseRef.current = onClose;

	if (!endpointInfo) {
		return null;
	}

	/**
	 * Process endpoint info to replace {host} placeholders with actual host
	 */
	const processEndpointInfo = (info: EndpointInfo, hostValue: string): EndpointInfo => {
		if (!hostValue) {
			return info;
		}

		const processed: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(info)) {
			if (typeof value === 'string') {
				processed[key] = value.replace(/{host}/g, hostValue);
			} else {
				processed[key] = value;
			}
		}
		return processed as EndpointInfo;
	};

	// Get processed endpoint info with host replaced
	const processedInfo = processEndpointInfo(endpointInfo, host);

	/**
	 * Copy text to clipboard with visual feedback
	 */
	const handleCopy = (text: string, label: string) => {
		navigator.clipboard.writeText(text).then(() => {
			setCopyFeedback(label);
			setTimeout(() => setCopyFeedback(null), 1500);
		}).catch(err => {
			console.error('Failed to copy:', err);
		});
	};

	/**
	 * Toggle auth key visibility
	 */
	const toggleKeyVisibility = () => {
		setIsKeyVisible(!isKeyVisible);
	};

	/**
	 * Toggle token visibility
	 */
	const toggleTokenVisibility = () => {
		setIsTokenVisible(!isTokenVisible);
	};

	/**
	 * Close modal when clicking backdrop
	 */
	const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (e.target === e.currentTarget) {
			onCloseRef.current();
		}
	};

	/**
	 * Mask the auth key with bullets
	 */
	const maskedKey = '•••••••••••••••••••';

	return (
		<div className={`modal-overlay ${isOpen ? 'active' : ''}`} onClick={handleBackdropClick}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				{/* Modal Header */}
				<div className="modal-header">
					<div className="modal-title">
						<span>🔑</span>
						<span>Endpoint Configuration</span>
					</div>
					<button className="close-btn" onClick={() => onCloseRef.current()}>×</button>
				</div>

				{/* Modal Body */}
				<div className="modal-body">
					{/* URL Section */}
					<div className="config-item">
						<div className="config-label">{processedInfo['url-text']}</div>
						<div className="config-value-container">
							<div className="config-value">
								<a
									href="#"
									onClick={(e) => {
										e.preventDefault();
										onOpenExternal(processedInfo['url-link']);
									}}
								>
									{processedInfo['url-link']}
								</a>
							</div>
							<button
								className={`icon-btn ${copyFeedback === 'url' ? 'success' : ''}`}
								onClick={() => handleCopy(processedInfo['url-link'], 'url')}
							>
								{copyFeedback === 'url' ? 'Copied!' : 'Copy'}
							</button>
							<button
								className="icon-btn"
								onClick={() => onOpenExternal(processedInfo['url-link'])}
							>
								Open
							</button>
						</div>
					</div>

					{/* Auth Key Section */}
					<div className="config-item">
						<div className="config-label">{processedInfo['auth-text']}</div>
						<div className="config-value-container">
							<div className={`config-value ${!isKeyVisible ? 'masked' : ''}`}>
								{isKeyVisible ? processedInfo['auth-key'] : maskedKey}
							</div>
							<button
								className={`icon-btn ${copyFeedback === 'key' ? 'success' : ''}`}
								onClick={() => handleCopy(processedInfo['auth-key'], 'key')}
							>
								{copyFeedback === 'key' ? 'Copied!' : 'Copy'}
							</button>
							<button
								className="icon-btn"
								onClick={toggleKeyVisibility}
							>
								{isKeyVisible ? 'Hide' : 'Show'}
							</button>
						</div>
					</div>

					{/* Token Section (if available) */}
					{processedInfo['token-key'] && processedInfo['token-text'] && (
						<div className="config-item">
							<div className="config-label">{processedInfo['token-text']}</div>
							<div className="config-value-container">
								<div className={`config-value ${!isTokenVisible ? 'masked' : ''}`}>
									{isTokenVisible ? processedInfo['token-key'] : maskedKey}
								</div>
								<button
									className={`icon-btn ${copyFeedback === 'token' ? 'success' : ''}`}
									onClick={() => handleCopy(processedInfo['token-key']!, 'token')}
								>
									{copyFeedback === 'token' ? 'Copied!' : 'Copy'}
								</button>
								<button
									className="icon-btn"
									onClick={toggleTokenVisibility}
								>
									{isTokenVisible ? 'Hide' : 'Show'}
								</button>
							</div>
						</div>
					)}

					{/* Security Note */}
					<div className="security-note">
						⚠️ <strong>Security:</strong> Keep your authentication credentials secure.
						Do not share them publicly or commit them to version control.
					</div>
				</div>
			</div>
		</div>
	);
};
