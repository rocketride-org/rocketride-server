// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * EndpointInfoModal — Plain React modal showing endpoint configuration details.
 *
 * Displays the endpoint URL, auth key, and optional private token with
 * copy-to-clipboard and show/hide functionality. Mirrors the behavior of
 * the PageStatus EndpointInfoModal.
 *
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React, { ReactElement, useState } from 'react';
import { createPortal } from 'react-dom';
import { IEndpointInfo } from './PipelineActions';
import { modalStyles as styles } from './index.style';

// =============================================================================
// Props
// =============================================================================

interface IEndpointInfoModalProps {
	/** Endpoint configuration data. */
	endpointInfo: IEndpointInfo | null;
	/** Whether the modal is open. */
	isOpen: boolean;
	/** Handler to close the modal. */
	onClose: () => void;
	/** Handler to open external URLs. */
	onOpenLink?: (url: string, displayName?: string) => void;
	/** Display name for the source node (used as the tab title when opening links). */
	displayName?: string;
	/** Host to replace {host} placeholders in all values. */
	host?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Replaces {host} placeholders in all string values of the endpoint info. */
function processEndpointInfo(info: IEndpointInfo, host?: string): IEndpointInfo {
	if (!host) return info;
	const processed = { ...info };
	for (const key of Object.keys(processed) as (keyof IEndpointInfo)[]) {
		const value = processed[key];
		if (typeof value === 'string') {
			(processed[key] as string) = value.replace(/{host}/g, host);
		}
	}
	return processed;
}

const MASKED_VALUE = '•••••••••••••••••••';

// =============================================================================
// Component
// =============================================================================

export default function EndpointInfoModal({ endpointInfo, isOpen, onClose, onOpenLink, displayName, host }: IEndpointInfoModalProps): ReactElement | null {
	const [isKeyVisible, setIsKeyVisible] = useState(false);
	const [isTokenVisible, setIsTokenVisible] = useState(false);
	const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

	const onCloseRef = React.useRef(onClose);
	onCloseRef.current = onClose;

	if (!endpointInfo || !isOpen) return null;

	const processed = processEndpointInfo(endpointInfo, host);

	const handleCopy = (text: string, label: string) => {
		navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopyFeedback(label);
				setTimeout(() => setCopyFeedback(null), 1500);
			})
			.catch(() => {
				// Clipboard not available
			});
	};

	const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (e.target === e.currentTarget) {
			onCloseRef.current();
		}
	};

	const iconBtn = (label: string): React.CSSProperties => ({
		...styles.iconBtn,
		...(copyFeedback === label ? styles.iconBtnSuccess : {}),
	});

	return createPortal(
		<div style={styles.overlay} onClick={handleBackdropClick}>
			<div style={styles.modal} onClick={(e) => e.stopPropagation()}>
				{/* Header */}
				<div style={styles.header}>
					<div style={styles.title}>Endpoint Configuration</div>
					<button style={styles.closeBtn} onClick={() => onCloseRef.current()}>
						×
					</button>
				</div>

				{/* Body */}
				<div style={styles.body}>
					{/* URL Section */}
					<div style={styles.configItem}>
						<div style={styles.configLabel}>{processed['url-text']}</div>
						<div style={styles.configValueRow}>
							<div style={styles.configValueLink}>
								<a
									href="#"
									style={styles.link}
									onClick={(e) => {
										e.preventDefault();
										onOpenLink?.(processed['url-link'], displayName);
									}}
								>
									{processed['url-link']}
								</a>
							</div>
							<button style={iconBtn('url')} onClick={() => handleCopy(processed['url-link'], 'url')}>
								{copyFeedback === 'url' ? 'Copied!' : 'Copy'}
							</button>
							<button style={styles.iconBtn} onClick={() => onOpenLink?.(processed['url-link'], displayName)}>
								Open
							</button>
						</div>
					</div>

					{/* Auth Key Section */}
					<div style={styles.configItem}>
						<div style={styles.configLabel}>{processed['auth-text']}</div>
						<div style={styles.configValueRow}>
							<div style={isKeyVisible ? styles.configValue : styles.configValueMasked}>{isKeyVisible ? processed['auth-key'] : MASKED_VALUE}</div>
							<button style={iconBtn('key')} onClick={() => handleCopy(processed['auth-key'], 'key')}>
								{copyFeedback === 'key' ? 'Copied!' : 'Copy'}
							</button>
							<button style={styles.iconBtn} onClick={() => setIsKeyVisible(!isKeyVisible)}>
								{isKeyVisible ? 'Hide' : 'Show'}
							</button>
						</div>
					</div>

					{/* Token Section (if available) */}
					{processed['token-key'] && processed['token-text'] && (
						<div style={styles.configItem}>
							<div style={styles.configLabel}>{processed['token-text']}</div>
							<div style={styles.configValueRow}>
								<div style={isTokenVisible ? styles.configValue : styles.configValueMasked}>{isTokenVisible ? processed['token-key'] : MASKED_VALUE}</div>
								<button style={iconBtn('token')} onClick={() => handleCopy(processed['token-key']!, 'token')}>
									{copyFeedback === 'token' ? 'Copied!' : 'Copy'}
								</button>
								<button style={styles.iconBtn} onClick={() => setIsTokenVisible(!isTokenVisible)}>
									{isTokenVisible ? 'Hide' : 'Show'}
								</button>
							</div>
						</div>
					)}

					{/* Security Note */}
					<div style={styles.securityNote}>
						<strong>Security:</strong> Keep your authentication credentials secure. Do not share them publicly or commit them to version control.
					</div>
				</div>
			</div>
		</div>,
		document.body
	);
}
