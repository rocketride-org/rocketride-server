// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * EndpointInfoModal — Plain React modal showing endpoint configuration details.
 *
 * Displays the endpoint URL and address, the minted key for the endpoint,
 * and integration examples (cURL / wget / TypeScript / Python / HTTP). No
 * credential rides a URL (plan §2.4); the node's front end opens from the
 * node's own button, not from here (plan §3.6).
 */

import React, { ReactElement, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IEndpointInfo, OpenToolHandler } from './PipelineActions';
import type { IOpenToolNote } from './openTool';
import { buildIntegrationExamples, defaultWebhookPayloadId, getWebhookPayload, WEBHOOK_PAYLOADS, type IntegrationTabId, type WebhookPayloadId } from './endpointIntegrationExamples';
import type { EndpointKeyMinter, IMintedEndpointKey } from './endpointKey';
import { Button, commonStyles } from 'shell';

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
	/** The source's front end, when the note names one (a chat/dropper source; plan 3.6). */
	tool?: IOpenToolNote;
	/** Opens that front end; absent = the host has no tool workbench. */
	onOpenTool?: OpenToolHandler;
	/** Display name for the source node (used as the tab title when opening links). */
	displayName?: string;
	/** Host to replace {host} placeholders in all values. */
	host?: string;
	/** Mints the owner's scoped key for this endpoint (plan §2.4). Absent = the host cannot mint keys. */
	onCreateEndpointKey?: EndpointKeyMinter;
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

export default function EndpointInfoModal({ endpointInfo, isOpen, onClose, onOpenLink, tool, onOpenTool, displayName, host, onCreateEndpointKey }: IEndpointInfoModalProps): ReactElement | null {
	// The key minted for THIS endpoint, shown once (plan §2.4): never stored,
	// dropped when the modal shows another endpoint.
	const [minted, setMinted] = useState<IMintedEndpointKey | null>(null);
	const [minting, setMinting] = useState(false);
	const [mintError, setMintError] = useState<string | null>(null);
	// Bumped per mint and per endpoint change; a mint whose generation is no
	// longer current belongs to a previous endpoint and is ignored.
	const mintGenerationRef = React.useRef(0);
	const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<IntegrationTabId>('curl');
	// The picked payload is an OVERRIDE, not the value itself: the modal stays
	// mounted between openings, so seeding state from the lanes would freeze the
	// first pipeline's answer. Deriving on each render keeps the preselection
	// honest, while a click still wins until the endpoint changes.
	const [payloadOverride, setPayloadOverride] = useState<WebhookPayloadId | null>(null);

	const onCloseRef = React.useRef(onClose);
	onCloseRef.current = onClose;

	// Drop a manual pick when the panel is showing a different endpoint.
	const endpointKey = endpointInfo?.['url-link'] ?? endpointInfo?.address ?? null;
	React.useEffect(() => {
		setPayloadOverride(null);
		setMinted(null);
		setMintError(null);
		setMinting(false);
		mintGenerationRef.current++;
	}, [endpointKey]);

	if (!endpointInfo || !isOpen) return null;

	const processed = processEndpointInfo(endpointInfo, host);
	// A chat/dropper source has no URL (its page servers are gone): the modal
	// then shows the address and the Open button, no door and no examples.
	const endpointUrl = processed['url-link'] ?? '';
	const address = processed.address;
	const isLocalEndpoint = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(endpointUrl);
	const isWebhookEndpoint = /web[\s-]?hook/i.test(endpointUrl) || /web[\s-]?hook/i.test(processed['url-text'] ?? '');

	const connectedLanes = endpointInfo.lanes;
	const payloadId = payloadOverride ?? defaultWebhookPayloadId(connectedLanes);
	// The snippets carry the minted key once there is one, the placeholder before.
	const examples = buildIntegrationExamples({ endpointUrl, authKey: minted?.key, isWebhook: isWebhookEndpoint, payloadId });

	/** Create API key: task.data on this address, frozen to the home team, shown once.
	 *  A mint is tied to the endpoint it started for: the modal stays mounted
	 *  between endpoints, so a result that lands after the endpoint changed is
	 *  dropped rather than shown as the new endpoint's key. */
	const handleMint = async (): Promise<void> => {
		if (!onCreateEndpointKey || !address) return;
		const mine = ++mintGenerationRef.current;
		setMinting(true);
		setMintError(null);
		try {
			const result = await onCreateEndpointKey(address);
			if (mine !== mintGenerationRef.current) return;
			setMinted(result);
		} catch (e) {
			if (mine !== mintGenerationRef.current) return;
			setMintError(e instanceof Error ? e.message : String(e));
		} finally {
			if (mine === mintGenerationRef.current) setMinting(false);
		}
	};
	const payload = getWebhookPayload(payloadId);
	const readsChosenLane = connectedLanes?.includes(payload.lane) ?? true;

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

	const iconBtn = (label: string): React.CSSProperties => ({
		...styles.iconBtn,
		...(copyFeedback === label ? styles.iconBtnSuccess : {}),
	});

	// A chat / dropper source is used through its signed-in app: the node's
	// own button opens it beside the canvas, and a link that names the pipe
	// (?appid=…&pipe=<address>) opens it in the browser (plan §3.6). No
	// credential rides a URL (plan §2.4).
	const envHintText = isWebhookEndpoint ? (isLocalEndpoint ? 'This endpoint points to a local host. Use a public tunnel/domain before integrating external webhook providers.' : 'This endpoint uses a non-local host and can be used for external webhook integrations.') : 'This source has no URL. Open it in its app beside the canvas, or share a link that names the pipe (?appid=<app>&pipe=<address>); sign-in happens in the app, so no key rides a URL. The SDK reaches it by address.';

	return createPortal(
		/* Backdrop is inert: dismissal is deliberate-only (close button) per the
		   2026-07-08 design decision — clicking outside must NOT close. */
		<div style={styles.overlay}>
			<div style={styles.modal}>
				{/* Header */}
				<div style={styles.header}>
					<div style={styles.title}>{displayName ? `Endpoint — ${displayName}` : 'Endpoint'}{address ? ` (${address})` : ''}</div>
					<button style={styles.closeBtn} onClick={() => onCloseRef.current()}>
						×
					</button>
				</div>

				{/* Body */}
				<div style={styles.body}>
					{/* URL Section — the data door of a webhook */}
					{endpointUrl ? (
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
					) : (
						/* A front end without a door: the node's Open button, beside the address below */
						<div style={styles.configItem}>
							<div style={styles.envHint}>{envHintText}</div>
							{tool && onOpenTool && (
								<div style={styles.configValueRow}>
									<Button small variant="primary" onClick={() => onOpenTool(tool.appId, tool.address, tool.nodeId)}>
										{tool.label}
									</Button>
								</div>
							)}
						</div>
					)}

					{/* Address — what a caller POSTs to and what a key is scoped to (plan §2.2) */}
					{address && (
						<div style={styles.configItem}>
							<div style={styles.configLabel}>Address</div>
							<div style={styles.configValueRow}>
								<div style={styles.configValue}>{address}</div>
								<button style={iconBtn('address')} onClick={() => handleCopy(address, 'address')}>
									{copyFeedback === 'address' ? 'Copied!' : 'Copy'}
								</button>
							</div>
						</div>
					)}

					{/* Key for this endpoint — the modal MINTS it (plan §2.4, mockup 3.5):
					    task.data, this one address, the home team, shown once; it is
					    listed and revoked in Settings › Account › API Keys. */}
					{isWebhookEndpoint && address && (
						<div style={styles.configItem}>
							<div style={styles.configLabel}>Key for this endpoint</div>
							<div style={styles.envHint}>External systems POST to this address with an account key in the Authorization header; ?auth= is not accepted. Create API key mints a key scoped to task.data on {address}, frozen to your home team, with no expiry. Nothing broader.</div>
							{minted ? (
								<>
									<div style={styles.configValueRow}>
										<div style={styles.configValue}>{minted.key}</div>
										<button style={iconBtn('mintedKey')} onClick={() => handleCopy(minted.key, 'mintedKey')}>
											{copyFeedback === 'mintedKey' ? 'Copied!' : 'Copy'}
										</button>
									</div>
									<div style={styles.securityNote}>
										<strong>Shown once:</strong> copy it now. It is listed in Settings › Account › API Keys as &quot;{minted.name}&quot;{minted.teamId ? ' with its frozen team' : ''}; revoke it there. The examples below carry it.
									</div>
								</>
							) : (
								<div style={styles.configValueRow}>
									{onCreateEndpointKey ? (
										<button style={styles.iconBtn} disabled={minting} onClick={() => void handleMint()}>
											{minting ? 'Creating…' : 'Create API key'}
										</button>
									) : (
										<div style={styles.envHint}>This host cannot mint keys; create one in Settings › Account › API Keys with this address as its endpoint.</div>
									)}
								</div>
							)}
							{mintError && <div style={styles.securityNote}>Could not create the key: {mintError}</div>}
						</div>
					)}

					{/* Integration examples — only a door has them */}
					{endpointUrl && (
					<div style={styles.testBox}>
						<div style={styles.testTitle}>Integration examples</div>
						<div style={styles.envHint}>{isWebhookEndpoint ? `Webhook: POST with the account key in the Authorization header${minted ? '' : ' (the snippets show a placeholder until you create a key)'}.` : 'Chat / UI: the SDK talks to this source by address (client.chat / sendFiles); the page URL carries no credential.'}</div>
						{isWebhookEndpoint && (
							<>
								<div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
									{WEBHOOK_PAYLOADS.map((option) => (
										<button key={option.id} style={commonStyles.toggleButton(payloadId === option.id)} onClick={() => setPayloadOverride(option.id)}>
											{option.label}
										</button>
									))}
								</div>
								<div style={styles.envHint}>
									Sends <code>{payload.contentType}</code>, which the engine delivers on the <strong>{payload.lane}</strong> lane.
									{connectedLanes?.length ? (
										<>
											{' '}
											This pipeline reads <strong>{connectedLanes.join(', ')}</strong>.{!readsChosenLane && <> Nothing reads the {payload.lane} lane, so this body is answered 200 OK but reaches no component.</>}
										</>
									) : (
										<> Pick the lane your first component reads. A body sent on a lane nothing reads is answered 200 OK but reaches no component.</>
									)}
								</div>
							</>
						)}
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
					)}
				</div>
			</div>
		</div>,
		document.body
	);
}
