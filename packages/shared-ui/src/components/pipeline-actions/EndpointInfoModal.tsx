// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * EndpointInfoModal — Plain React modal showing endpoint configuration details.
 *
 * Displays URL, optional URL with `?auth=`, auth key, integration examples
 * (cURL / wget / TypeScript / Python / HTTP), and optional private token.
 */

import React, { ReactElement, useState } from 'react';
import { createPortal } from 'react-dom';
import { IEndpointInfo } from './PipelineActions';
import { appendAuthQueryParam, buildIntegrationExamples, type IntegrationTabId } from './endpointIntegrationExamples';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// Styles
// =============================================================================

import type { CSSProperties } from 'react';

const styles: Record<string, CSSProperties> = {
	overlay: commonStyles.overlay,

	modal: {
		backgroundColor: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: '8px',
		width: '100%',
		maxWidth: '780px',
		maxHeight: '90vh',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
		boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
	},

	header: {
		...commonStyles.cardHeader,
		borderRadius: '8px 8px 0 0',
	},

	title: {
		fontSize: '14px',
		fontWeight: 600,
		color: 'var(--rr-text-primary, inherit)',
	},

	closeBtn: {
		background: 'none',
		border: 'none',
		color: 'var(--rr-text-secondary)',
		fontSize: '18px',
		cursor: 'pointer',
		padding: '4px 8px',
		borderRadius: '4px',
	},

	body: {
		padding: '20px',
		overflowY: 'auto',
		flex: 1,
		minHeight: 0,
	},

	configItem: {
		marginBottom: '16px',
	},
	envRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		marginBottom: '10px',
	},
	envLabel: {
		fontSize: '11px',
		fontWeight: 600,
		color: 'var(--rr-text-secondary)',
	},
	envBadgeLocal: {
		fontSize: '10px',
		fontWeight: 700,
		padding: '2px 6px',
		borderRadius: '10px',
		backgroundColor: 'rgba(255, 193, 7, 0.15)',
		color: 'var(--rr-color-warning)',
		border: '1px solid rgba(255, 193, 7, 0.35)',
	},
	envBadgeProd: {
		fontSize: '10px',
		fontWeight: 700,
		padding: '2px 6px',
		borderRadius: '10px',
		backgroundColor: 'rgba(78, 201, 176, 0.15)',
		color: 'var(--rr-success)',
		border: '1px solid rgba(78, 201, 176, 0.35)',
	},
	envHint: {
		fontSize: '11px',
		color: 'var(--rr-text-disabled)',
		marginBottom: '14px',
		lineHeight: 1.45,
	},
	testBox: {
		marginTop: '14px',
		padding: '10px',
		backgroundColor: 'var(--rr-bg-surface-alt, var(--rr-bg-paper))',
		border: '1px solid var(--rr-border)',
		borderRadius: '4px',
	},
	testTitle: {
		...commonStyles.labelUppercase,
		marginBottom: '8px',
	},
	curlBlock: {
		fontSize: '11px',
		...commonStyles.fontMono,
		lineHeight: 1.45,
		color: 'var(--rr-text-primary, inherit)',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		marginBottom: '8px',
	},
	testActions: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
		marginTop: '12px',
	},
	integrationCodeScroll: {
		maxHeight: '220px',
		overflow: 'auto',
		padding: '10px',
		backgroundColor: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: '4px',
	},

	configLabel: {
		...commonStyles.labelUppercase,
		marginBottom: '6px',
	},

	configValueRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		minHeight: '32px',
		paddingLeft: '28px',
	},

	configValueLink: {
		flex: 1,
		...commonStyles.textEllipsis,
	},

	link: {
		color: 'var(--rr-text-link)',
		textDecoration: 'none',
		fontSize: '12px',
	},

	configValue: {
		flex: 1,
		fontSize: '12px',
		color: 'var(--rr-text-primary, inherit)',
		...commonStyles.fontMono,
		...commonStyles.textEllipsis,
	},

	configValueMasked: {
		flex: 1,
		fontSize: '12px',
		color: 'var(--rr-text-disabled)',
		...commonStyles.fontMono,
		letterSpacing: '2px',
	},

	iconBtn: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 8px',
		borderRadius: '3px',
		border: '1px solid var(--rr-border)',
		cursor: 'pointer',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		fontSize: '11px',
		fontWeight: 500,
		whiteSpace: 'nowrap',
	},

	iconBtnSuccess: {
		backgroundColor: 'var(--rr-accent)',
		borderColor: 'var(--rr-accent)',
		color: 'var(--rr-fg-button)',
	},

	securityNote: {
		marginTop: '16px',
		padding: '10px 12px',
		background: 'rgba(255, 152, 0, 0.1)',
		borderLeft: '3px solid var(--rr-color-warning)',
		borderRadius: '4px',
		fontSize: '11px',
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	},
};

// =============================================================================
// Types
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

const TAB_ORDER: IntegrationTabId[] = ['curl', 'curlCmd', 'powershell', 'wget', 'typescript', 'python', 'http'];

const TAB_LABELS: Record<IntegrationTabId, string> = {
	curl: 'cURL (Bash)',
	curlCmd: 'cURL (cmd)',
	powershell: 'PowerShell',
	wget: 'wget',
	typescript: 'TypeScript',
	python: 'Python',
	http: 'HTTP',
};

const INTEGRATION_TABS = TAB_ORDER.map((id) => ({ id, label: TAB_LABELS[id] }));

// =============================================================================
// Component
// =============================================================================

export default function EndpointInfoModal({ endpointInfo, isOpen, onClose, onOpenLink, displayName, host }: IEndpointInfoModalProps): ReactElement | null {
	const [isTokenVisible, setIsTokenVisible] = useState(false);
	const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<IntegrationTabId>('curl');

	const onCloseRef = React.useRef(onClose);
	onCloseRef.current = onClose;

	if (!endpointInfo || !isOpen) return null;

	const processed = processEndpointInfo(endpointInfo, host);
	const endpointUrl = processed['url-link'];
	const authKey = processed['auth-key'];
	const urlWithAuth = appendAuthQueryParam(endpointUrl, authKey);
	const isLocalEndpoint = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(endpointUrl);
	const isWebhookEndpoint = /web[\s-]?hook/i.test(endpointUrl) || /web[\s-]?hook/i.test(processed['url-text'] ?? '');

	const examples = buildIntegrationExamples({ endpointUrl, authKey, isWebhook: isWebhookEndpoint });

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

	const envHintText = isWebhookEndpoint ? (isLocalEndpoint ? 'This endpoint points to a local host. Use a public tunnel/domain before integrating external webhook providers.' : 'This endpoint uses a non-local host and can be used for external webhook integrations.') : isLocalEndpoint ? 'Local URL. For embedding outside VS Code, copy the URL with auth or use the integration examples below.' : 'Use the URL with auth query or the examples below to integrate into your application.';

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
						<div style={styles.envRow}>
							<span style={styles.envLabel}>Environment</span>
							<span style={isLocalEndpoint ? styles.envBadgeLocal : styles.envBadgeProd}>{isLocalEndpoint ? 'Local' : 'Production'}</span>
						</div>
						<div style={styles.envHint}>{envHintText}</div>
						<div style={styles.configLabel}>{processed['url-text']}</div>
						<div style={styles.configValueRow}>
							<div style={styles.configValueLink}>
								<a
									href="#"
									style={styles.link}
									onClick={(e) => {
										e.preventDefault();
										onOpenLink?.(endpointUrl, displayName);
									}}
								>
									{endpointUrl}
								</a>
							</div>
							<button style={iconBtn('url')} onClick={() => handleCopy(endpointUrl, 'url')}>
								{copyFeedback === 'url' ? 'Copied!' : 'Copy'}
							</button>
						</div>
					</div>

					{/* URL with auth (query) — easier for apps that cannot set headers */}
					<div style={styles.configItem}>
						<div style={styles.configLabel}>URL with auth (query)</div>
						<div style={styles.envHint}>(e.g. /chat?auth=pk_...) — use when you cannot send an Authorization header.</div>
						<div style={styles.configValueRow}>
							<div style={styles.configValueLink} title={urlWithAuth}>
								<a
									href="#"
									style={styles.link}
									onClick={(e) => {
										e.preventDefault();
										onOpenLink?.(urlWithAuth, displayName);
									}}
								>
									{urlWithAuth}
								</a>
							</div>
							<button style={styles.iconBtn} onClick={() => onOpenLink?.(urlWithAuth, displayName)}>
								Open
							</button>
							<button style={iconBtn('urlAuth')} onClick={() => handleCopy(urlWithAuth, 'urlAuth')}>
								{copyFeedback === 'urlAuth' ? 'Copied!' : 'Copy'}
							</button>
						</div>
					</div>

					{/* Auth Key Section */}
					<div style={styles.configItem}>
						<div style={styles.configLabel}>{processed['auth-text']}</div>
						<div style={styles.configValueRow}>
							<div style={styles.configValue}>{processed['auth-key']}</div>
							<button style={iconBtn('key')} onClick={() => handleCopy(processed['auth-key'], 'key')}>
								{copyFeedback === 'key' ? 'Copied!' : 'Copy'}
							</button>
						</div>
					</div>

					{/* Token Section (if available) */}
					{processed['token-key'] && processed['token-text'] && (
						<div style={styles.configItem}>
							<div style={styles.configLabel}>{processed['token-text']}</div>
							<div style={styles.configValueRow}>
								<div style={isTokenVisible ? styles.configValue : styles.configValueMasked}>{isTokenVisible ? processed['token-key'] : MASKED_VALUE}</div>
								<button style={styles.iconBtn} onClick={() => setIsTokenVisible(!isTokenVisible)}>
									{isTokenVisible ? 'Hide' : 'Show'}
								</button>
								<button style={iconBtn('token')} onClick={() => handleCopy(processed['token-key']!, 'token')}>
									{copyFeedback === 'token' ? 'Copied!' : 'Copy'}
								</button>
							</div>
						</div>
					)}

					{/* Security Note */}
					<div style={styles.securityNote}>
						<strong>Security:</strong> Keep your authentication credentials secure. Do not share them publicly or commit them to version control.
					</div>

					{/* Integration examples */}
					<div style={styles.testBox}>
						<div style={styles.testTitle}>Integration examples</div>
						<div style={styles.envHint}>{isWebhookEndpoint ? 'Webhook: POST JSON with Bearer auth, or use the URL with ?auth= if supported.' : 'Chat / UI: prefer opening the URL with auth in a browser or embedded webview.'}</div>
						<div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
							{INTEGRATION_TABS.map((tab) => (
								<button key={tab.id} style={commonStyles.toggleButton(activeTab === tab.id)} onClick={() => setActiveTab(tab.id as IntegrationTabId)}>
									{tab.label}
								</button>
							))}
						</div>
						<div style={styles.integrationCodeScroll}>
							<div style={styles.curlBlock}>{examples[activeTab]}</div>
						</div>
						<div style={styles.testActions}>
							<button style={iconBtn(`ex-${activeTab}`)} onClick={() => handleCopy(examples[activeTab], `ex-${activeTab}`)}>
								{copyFeedback === `ex-${activeTab}` ? 'Copied!' : 'Copy'}
							</button>
							<button style={styles.iconBtn} onClick={() => onOpenLink?.('https://docs.rocketride.org/', 'RocketRide docs')}>
								Docs
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>,
		document.body
	);
}
