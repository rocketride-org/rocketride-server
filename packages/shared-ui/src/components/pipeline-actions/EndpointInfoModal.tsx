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
import { TabPanel } from '../tab-panel/TabPanel';
import { IEndpointInfo } from './PipelineActions';
import { modalStyles as styles } from './index.style';
import { appendAuthQueryParam, buildIntegrationExamples, type IntegrationTabId } from './endpointIntegrationExamples';

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
							<button style={styles.iconBtn} onClick={() => onOpenLink?.(endpointUrl, displayName)}>
								Open
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
							<button style={iconBtn('urlAuth')} onClick={() => handleCopy(urlWithAuth, 'urlAuth')}>
								{copyFeedback === 'urlAuth' ? 'Copied!' : 'Copy'}
							</button>
							<button style={styles.iconBtn} onClick={() => onOpenLink?.(urlWithAuth, displayName)}>
								Open
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

					{/* Integration examples */}
					<div style={styles.testBox}>
						<div style={styles.testTitle}>Integration examples</div>
						<div style={styles.envHint}>{isWebhookEndpoint ? 'Webhook: POST JSON with Bearer auth, or use the URL with ?auth= if supported.' : 'Chat / UI: prefer opening the URL with auth in a browser or embedded webview.'}</div>
						<TabPanel tabs={INTEGRATION_TABS} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as IntegrationTabId)}>
							<div style={styles.integrationCodeScroll}>
								<div style={styles.curlBlock}>{examples[activeTab]}</div>
							</div>
						</TabPanel>
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
