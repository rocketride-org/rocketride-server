// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useState, useEffect, CSSProperties } from 'react';
import { useMessaging } from '../hooks/useMessaging';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

// =============================================================================
// TYPES
// =============================================================================

interface ConnectionState {
	state: 'connected' | 'connecting' | 'downloading-engine' | 'starting-engine' | 'stopping-engine' | 'disconnected' | 'engine-startup-failed';
	connectionMode: 'cloud' | 'onprem' | 'local';
	retryAttempt: number;
	maxRetryAttempts: number;
	lastError?: string;
	progressMessage?: string;
}

const TRANSITIONAL_STATES: ReadonlySet<ConnectionState['state']> = new Set(['connecting', 'downloading-engine', 'starting-engine', 'stopping-engine']);

interface Config {
	hostUrl: string;
	connectionMode: 'cloud' | 'onprem' | 'local';
	autoConnect: boolean;
}

interface EngineInfo {
	version: string | null;
	publishedAt: string | null;
}

interface ConnectionData {
	connectionState: ConnectionState;
	config: Config;
	hasApiKey: boolean;
	engineInfo?: EngineInfo;
}

type PageConnectionIncomingMessage = {
	type: 'connectionUpdate';
	data: ConnectionData;
};

type PageConnectionOutgoingMessage = { type: 'view:ready' } | { type: 'connect' } | { type: 'disconnect' } | { type: 'reconnect' } | { type: 'openSettings' } | { type: 'openDocs' } | { type: 'openDeploy' } | { type: 'openDashboard' };

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		position: 'fixed',
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: 'var(--rr-bg-widget)',
		overflowY: 'auto',
	} as CSSProperties,
	view: {
		backgroundColor: 'var(--rr-bg-widget)',
		color: 'var(--rr-fg-widget)',
		padding: 8,
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		minHeight: '100%',
	} as CSSProperties,
	warningBanner: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 8,
		padding: 8,
		background: 'var(--vscode-inputValidation-warningBackground)',
		border: '1px solid var(--vscode-inputValidation-warningBorder)',
		borderRadius: 3,
	} as CSSProperties,
	warningIcon: {
		fontSize: 16,
		lineHeight: 1,
		flexShrink: 0,
	} as CSSProperties,
	warningTitle: {
		fontWeight: 600,
		fontSize: 12,
		color: 'var(--rr-text-primary)',
		marginBottom: 2,
	} as CSSProperties,
	warningMessage: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	statusCard: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: 8,
	} as CSSProperties,
	statusIndicatorBase: {
		width: 32,
		height: 32,
		borderRadius: '50%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 16,
		flexShrink: 0,
		transition: 'all 0.3s ease',
		color: 'white',
		fontWeight: 'bold',
	} as CSSProperties,
	statusText: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	statusLabel: {
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		marginBottom: 2,
	} as CSSProperties,
	statusDetail: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		minHeight: '1.25em',
		lineHeight: '1.25em',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,
	connectionInfo: {
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
		padding: 8,
	} as CSSProperties,
	infoRow: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		fontSize: 12,
		gap: 8,
	} as CSSProperties,
	infoLabel: {
		color: 'var(--rr-text-secondary)',
		fontWeight: 400,
		flexShrink: 0,
	} as CSSProperties,
	infoValue: {
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--vscode-editor-font-family)',
		wordBreak: 'break-all',
		textAlign: 'right',
		fontSize: 11,
	} as CSSProperties,
	actionButtons: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: 6,
		padding: '0 12px',
		marginTop: 8,
	} as CSSProperties,
	btn: {
		padding: '4px 10px',
		border: 'none',
		borderRadius: 4,
		fontSize: 13,
		fontWeight: 400,
		cursor: 'pointer',
		textAlign: 'center',
		lineHeight: '20px',
		width: '100%',
		maxWidth: 200,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		background: 'var(--rr-bg-button)',
		color: 'var(--rr-fg-button)',
	} as CSSProperties,
	btnDisabled: {
		opacity: 0.4,
		cursor: 'not-allowed',
	} as CSSProperties,
};

const STATUS_COLORS: Record<string, string> = {
	connected: 'var(--rr-color-success)',
	connecting: 'var(--rr-color-warning)',
	'downloading-engine': 'var(--rr-color-warning)',
	'starting-engine': 'var(--rr-color-warning)',
	'stopping-engine': 'var(--rr-color-warning)',
	disconnected: 'var(--rr-text-disabled)',
	'engine-startup-failed': 'var(--rr-text-disabled)',
	loading: 'var(--rr-text-disabled)',
};

// =============================================================================
// COMPONENT
// =============================================================================

export const PageConnection: React.FC = () => {
	const [connectionData, setConnectionData] = useState<ConnectionData | null>(null);
	const [animationPhase, setAnimationPhase] = useState(0);
	const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

	const { sendMessage } = useMessaging<PageConnectionOutgoingMessage, PageConnectionIncomingMessage>({
		onMessage: (message) => {
			if (message.type === 'connectionUpdate') {
				setConnectionData(message.data);
			}
		},
	});

	// Animate connecting dots
	useEffect(() => {
		const isTransitional = connectionData?.connectionState.state && TRANSITIONAL_STATES.has(connectionData.connectionState.state);
		if (isTransitional) {
			const interval = setInterval(() => setAnimationPhase((prev) => (prev + 1) % 4), 500);
			return () => clearInterval(interval);
		}
	}, [connectionData?.connectionState.state]);

	const getAnimatedDots = (): string => '.'.repeat(animationPhase);

	const getStatusLabel = (): string => {
		if (!connectionData) return 'Loading...';
		const { state } = connectionData.connectionState;
		if (state === 'connected') return 'Connected';
		if (TRANSITIONAL_STATES.has(state)) return `Connecting${getAnimatedDots()}`;
		return 'Disconnected';
	};

	const getStatusIcon = (): string => {
		if (!connectionData) return '○';
		const { state } = connectionData.connectionState;
		if (state === 'connected') return '✓';
		if (TRANSITIONAL_STATES.has(state)) return '◷';
		return '○';
	};

	const getStatusDetailLine = (): string => {
		if (!connectionData) return '';
		const { state, lastError, progressMessage } = connectionData.connectionState;
		const isTransitional = TRANSITIONAL_STATES.has(state);

		if (isTransitional && progressMessage) return progressMessage;

		switch (state) {
			case 'downloading-engine':
				return 'Downloading server...';
			case 'starting-engine':
				return 'Starting server...';
			case 'connecting':
				return connectionData.connectionState.retryAttempt > 0 ? 'Retrying...' : 'Connecting to server...';
			case 'stopping-engine':
				return 'Stopping server...';
			default:
				break;
		}

		if (isTransitional && lastError) {
			const lower = lastError.toLowerCase();
			if (lower.includes('rate limit') || lower.includes('github')) return 'No release info.';
			return lastError.length > 40 ? lastError.slice(0, 37) + '...' : lastError;
		}

		if ((state === 'disconnected' || state === 'engine-startup-failed') && lastError) {
			return lastError.length > 40 ? lastError.slice(0, 37) + '...' : lastError;
		}
		return '';
	};

	const isConnecting = connectionData?.connectionState.state ? TRANSITIONAL_STATES.has(connectionData.connectionState.state) : false;
	const isConnected = connectionData?.connectionState.state === 'connected';
	const needsApiKeySetup = connectionData?.config.connectionMode === 'onprem' && !connectionData?.hasApiKey;
	const statusColor = STATUS_COLORS[connectionData?.connectionState.state ?? 'loading'];

	const btnStyle = (id: string, disabled?: boolean): CSSProperties => ({
		...styles.btn,
		...(disabled ? styles.btnDisabled : {}),
		...(hoveredBtn === id && !disabled ? { filter: 'brightness(1.2)' } : {}),
	});

	return (
		<div style={styles.container}>
			<div style={styles.view}>
				{needsApiKeySetup && (
					<div style={styles.warningBanner}>
						<div style={styles.warningIcon}>⚠️</div>
						<div>
							<div style={styles.warningTitle}>Setup Required</div>
							<div style={styles.warningMessage}>API Key must be configured for cloud mode</div>
						</div>
					</div>
				)}

				<div style={styles.statusCard}>
					<div style={{ ...styles.statusIndicatorBase, background: statusColor }}>
						<span>{getStatusIcon()}</span>
					</div>
					<div style={styles.statusText}>
						<div style={styles.statusLabel}>{getStatusLabel()}</div>
						{getStatusDetailLine() && (
							<div style={styles.statusDetail} title={connectionData?.connectionState.lastError || undefined}>
								{getStatusDetailLine()}
							</div>
						)}
					</div>
				</div>

				<div style={styles.connectionInfo}>
					<div style={styles.infoRow}>
						<span style={styles.infoLabel}>Server:</span>
						<span style={styles.infoValue}>{connectionData?.config.connectionMode === 'local' ? 'Local' : connectionData?.config.connectionMode === 'cloud' ? (connectionData as any)?.cloudUserName || 'RocketRide Cloud' : connectionData?.config.connectionMode === 'docker' ? 'Docker' : connectionData?.config.connectionMode === 'service' ? 'Service' : connectionData?.config.hostUrl || 'N/A'}</span>
					</div>
					{connectionData?.config.connectionMode === 'local' && connectionData?.engineInfo?.version && (
						<div style={styles.infoRow}>
							<span style={styles.infoLabel}>Engine:</span>
							<span style={styles.infoValue}>
								{connectionData.engineInfo.version.replace(/^server-/, '')}
								{connectionData.engineInfo.publishedAt && ` (${new Date(connectionData.engineInfo.publishedAt).toLocaleDateString()})`}
							</span>
						</div>
					)}
				</div>

				<div style={styles.actionButtons}>
					{isConnected ? (
						<button style={btnStyle('disconnect', isConnecting)} onClick={() => sendMessage({ type: 'disconnect' })} disabled={isConnecting} onMouseEnter={() => setHoveredBtn('disconnect')} onMouseLeave={() => setHoveredBtn(null)}>
							Disconnect
						</button>
					) : (
						<button style={btnStyle('connect', isConnecting || needsApiKeySetup)} onClick={() => sendMessage({ type: 'connect' })} disabled={isConnecting || needsApiKeySetup} onMouseEnter={() => setHoveredBtn('connect')} onMouseLeave={() => setHoveredBtn(null)}>
							Connect
						</button>
					)}
					<button style={btnStyle('monitor', !isConnected)} onClick={() => sendMessage({ type: 'openDashboard' })} title="Open server monitoring dashboard" disabled={!isConnected} onMouseEnter={() => setHoveredBtn('monitor')} onMouseLeave={() => setHoveredBtn(null)}>
						Monitor
					</button>
					<button style={btnStyle('settings')} onClick={() => sendMessage({ type: 'openSettings' })} onMouseEnter={() => setHoveredBtn('settings')} onMouseLeave={() => setHoveredBtn(null)}>
						Settings
					</button>
					<button style={btnStyle('deploy')} onClick={() => sendMessage({ type: 'openDeploy' })} title="Deploy to RocketRide.ai cloud or on-prem" onMouseEnter={() => setHoveredBtn('deploy')} onMouseLeave={() => setHoveredBtn(null)}>
						Deploy
					</button>
					<button style={btnStyle('docs')} onClick={() => sendMessage({ type: 'openDocs' })} title="View RocketRide API documentation and integration guide" onMouseEnter={() => setHoveredBtn('docs')} onMouseLeave={() => setHoveredBtn(null)}>
						Documentation
					</button>
				</div>
			</div>
		</div>
	);
};
