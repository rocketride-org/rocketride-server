// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useState, useEffect, CSSProperties } from 'react';
import { useMessaging } from 'shared';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

// =============================================================================
// TYPES
// =============================================================================

// These interfaces are intentionally duplicated from the extension host types
// (service-manager.ts, docker-manager.ts). The webview runs in a sandboxed
// iframe and cannot import from the extension — keep these in sync manually.
interface ServiceStatus {
	state: 'not-installed' | 'starting' | 'running' | 'stopping' | 'stopped';
	version: string | null;
	publishedAt: string | null;
	installPath: string | null;
}

interface DockerStatus {
	state: 'not-installed' | 'no-docker' | 'starting' | 'running' | 'stopping' | 'stopped';
	version: string | null;
	publishedAt: string | null;
	imageTag: string | null;
}

interface VersionItem {
	tag_name: string;
	prerelease: boolean;
}

type IncomingMessage = { type: 'init'; rocketrideLogoDarkUri?: string; rocketrideLogoLightUri?: string; dockerIconUri?: string; onpremIconUri?: string } | { type: 'serviceStatus'; status: ServiceStatus } | { type: 'dockerStatus'; status: DockerStatus } | { type: 'versionsLoaded'; versions: VersionItem[] } | { type: 'dockerVersionsLoaded'; tags: string[] } | { type: 'serviceProgress'; message: string } | { type: 'serviceComplete' } | { type: 'serviceError'; message: string } | { type: 'serviceNeedsSudo' } | { type: 'dockerProgress'; message: string } | { type: 'dockerComplete' } | { type: 'dockerError'; message: string };

type OutgoingMessage = { type: 'ready' } | { type: 'copyToClipboard'; text: string } | { type: 'fetchVersions' } | { type: 'serviceInstall'; version: string } | { type: 'serviceRemove' } | { type: 'serviceUpdate'; version: string } | { type: 'serviceStart' } | { type: 'serviceStop' } | { type: 'sudoPassword'; password: string } | { type: 'dockerInstall'; version: string } | { type: 'dockerRemove' } | { type: 'dockerUpdate'; version: string } | { type: 'dockerStart' } | { type: 'dockerStop' };

// =============================================================================
// HELPERS
// =============================================================================

const displayVersion = (tag: string): string => {
	if (tag === 'latest') return 'Latest';
	if (tag === 'prerelease') return 'Prerelease';
	return tag.replace(/^server-/, '');
};

const stateLabels: Record<string, string> = {
	'not-installed': '○ Not installed',
	'no-docker': '○ Docker unavailable',
	starting: '◐ Starting...',
	running: '● Running',
	stopping: '◐ Stopping...',
	stopped: '○ Stopped',
};

const IMAGE_BASE = 'ghcr.io/rocketride-org/rocketride-engine';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	panel: {
		maxWidth: 560,
		width: '100%',
		border: '1px solid var(--rr-border)',
		borderRadius: 12,
		padding: '25px 28px',
		backgroundColor: 'var(--rr-bg-default)',
		display: 'flex',
		flexDirection: 'row',
		alignItems: 'center',
		gap: 24,
		textAlign: 'left',
		boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
	} as CSSProperties,
	panelContent: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		minWidth: 0,
		flex: 1,
	} as CSSProperties,
	panelIcon: {
		width: 80,
		height: 80,
		objectFit: 'contain',
		flexShrink: 0,
	} as CSSProperties,
	statusBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
		marginTop: 8,
		fontSize: 13,
	} as CSSProperties,
	statusRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'baseline',
	} as CSSProperties,
	btn: {
		padding: '8px 14px',
		fontSize: 13,
		border: 'none',
		borderRadius: 4,
		cursor: 'pointer',
	} as CSSProperties,
	splitButton: {
		position: 'relative',
		display: 'inline-flex',
	} as CSSProperties,
	splitDropdown: {
		position: 'absolute',
		top: '100%',
		left: 0,
		right: 0,
		minWidth: 180,
		marginTop: 2,
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border-input)',
		borderRadius: 4,
		boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
		zIndex: 100,
		maxHeight: 200,
		overflowY: 'auto',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

export const PageDeploy: React.FC = () => {
	const [logoDarkUri, setLogoDarkUri] = useState<string | undefined>();
	const [logoLightUri, setLogoLightUri] = useState<string | undefined>();
	const [dockerUri, setDockerUri] = useState<string | undefined>();
	const [onpremUri, setOnpremUri] = useState<string | undefined>();

	// Detect VS Code theme for logo switching (dark theme -> show light logo, light theme -> show dark logo)
	const [isDarkTheme, setIsDarkTheme] = useState(() => document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast'));
	useEffect(() => {
		const observer = new MutationObserver(() => {
			setIsDarkTheme(document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast'));
		});
		observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	}, []);

	// Service state
	const [serviceStatus, setServiceStatus] = useState<ServiceStatus>({
		state: 'not-installed' as const,
		version: null,
		publishedAt: null,
		installPath: null,
	});
	const [serviceProgress, setServiceProgress] = useState<string | null>(null);
	const [serviceError, setServiceError] = useState<string | null>(null);
	const [serviceBusy, setServiceBusy] = useState(false);
	const [serviceAction, setServiceAction] = useState<'install' | 'update' | 'remove' | 'start' | 'stop' | null>(null);
	const [sudoPromptVisible, setSudoPromptVisible] = useState(false);
	const [sudoPasswordInput, setSudoPasswordInput] = useState('');

	// Docker state
	const [dockerStatus, setDockerStatus] = useState<DockerStatus>({
		state: 'not-installed' as const,
		version: null,
		publishedAt: null,
		imageTag: null,
	});
	const [dockerProgress, setDockerProgress] = useState<string | null>(null);
	const [dockerError, setDockerError] = useState<string | null>(null);
	const [dockerBusy, setDockerBusy] = useState(false);
	const [dockerAction, setDockerAction] = useState<'install' | 'update' | 'remove' | 'start' | 'stop' | null>(null);

	// Service version state
	const [versions, setVersions] = useState<VersionItem[]>([]);
	const [selectedVersion, setSelectedVersion] = useState('latest');

	// Docker version state
	const [dockerTags, setDockerTags] = useState<string[]>([]);
	const [dockerSelectedVersion, setDockerSelectedVersion] = useState('latest');

	// Hover state for buttons / dropdown options
	const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
	const [hoveredOption, setHoveredOption] = useState<string | null>(null);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (message) => {
			switch (message.type) {
				case 'init':
					if (message.rocketrideLogoDarkUri) setLogoDarkUri(message.rocketrideLogoDarkUri);
					if (message.rocketrideLogoLightUri) setLogoLightUri(message.rocketrideLogoLightUri);
					if (message.dockerIconUri) setDockerUri(message.dockerIconUri);
					if (message.onpremIconUri) setOnpremUri(message.onpremIconUri);
					break;
				// Service messages
				case 'serviceStatus':
					setServiceStatus(message.status);
					if (!serviceBusy) setServiceProgress(null);
					break;
				case 'serviceNeedsSudo':
					setSudoPromptVisible(true);
					break;
				case 'serviceProgress':
					setServiceProgress(message.message);
					setServiceError(null);
					break;
				case 'serviceComplete':
					setServiceBusy(false);
					setServiceAction(null);
					setServiceProgress(null);
					setSudoPromptVisible(false);
					setSudoPasswordInput('');
					break;
				case 'serviceError':
					setServiceError(message.message);
					setServiceBusy(false);
					setServiceAction(null);
					setServiceProgress(null);
					setSudoPromptVisible(false);
					setSudoPasswordInput('');
					break;
				// Docker messages
				case 'dockerStatus':
					setDockerStatus(message.status);
					if (!dockerBusy) setDockerProgress(null);
					break;
				case 'dockerProgress':
					setDockerProgress(message.message);
					setDockerError(null);
					break;
				case 'dockerComplete':
					setDockerBusy(false);
					setDockerAction(null);
					setDockerProgress(null);
					break;
				case 'dockerError':
					setDockerError(message.message);
					setDockerBusy(false);
					setDockerAction(null);
					setDockerProgress(null);
					break;
				// Version lists
				case 'versionsLoaded':
					setVersions(message.versions);
					break;
				case 'dockerVersionsLoaded':
					setDockerTags(message.tags);
					break;
			}
		},
	});

	useEffect(() => {
		sendMessage({ type: 'ready' });
		sendMessage({ type: 'fetchVersions' });
	}, [sendMessage]);

	// =========================================================================
	// VERSION OPTIONS
	// =========================================================================

	// Service panel: GitHub Releases
	const serviceVersionOptions = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...versions.map((v) => ({ value: v.tag_name, label: displayVersion(v.tag_name) }))];

	// Docker panel: GHCR image tags
	const dockerVersionOptions = [{ value: 'latest', label: '<Latest>' }, { value: 'prerelease', label: '<Prerelease>' }, ...dockerTags.map((t) => ({ value: t, label: t }))];

	// =========================================================================
	// DROPDOWN STATE
	// =========================================================================

	const [dropdownOpen, setDropdownOpen] = useState<string | null>(null);

	// Close dropdown on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target.closest('[data-split-button]')) {
				setDropdownOpen(null);
			}
		};
		document.addEventListener('click', handler);
		return () => document.removeEventListener('click', handler);
	}, []);

	// =========================================================================
	// BUTTON STYLE HELPERS
	// =========================================================================

	const primaryBtnStyle = (id: string, disabled?: boolean): CSSProperties => ({
		...styles.btn,
		background: 'var(--rr-bg-button)',
		color: 'var(--rr-fg-button)',
		...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
		...(hoveredBtn === id && !disabled ? { filter: 'brightness(1.2)' } : {}),
	});

	const secondaryBtnStyle = (id: string, disabled?: boolean): CSSProperties => ({
		...styles.btn,
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
		...(hoveredBtn === id && !disabled ? { filter: 'brightness(1.2)' } : {}),
	});

	const optionStyle = (key: string, isSelected: boolean): CSSProperties => ({
		appearance: 'none' as const,
		background: isSelected ? 'var(--rr-bg-list-active)' : hoveredOption === key ? 'var(--rr-bg-list-hover)' : 'none',
		border: 'none',
		width: '100%',
		textAlign: 'left',
		display: 'block',
		padding: '6px 12px',
		fontSize: 13,
		cursor: 'pointer',
		color: isSelected ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
	});

	// =========================================================================
	// SPLIT BUTTON
	// =========================================================================

	const renderSplitButton = (id: string, label: string, busyLabel: string, onClick: () => void, isBusy: boolean, isTransitional: boolean, currentVersion: string, onVersionChange: (v: string) => void, options: { value: string; label: string }[], primary: boolean = true) => {
		const isOpen = dropdownOpen === id;
		const isDisabled = isBusy || isTransitional;
		const currentLabel = options.find((v) => v.value === currentVersion)?.label ?? '<Latest>';
		const mainId = `${id}-main`;
		const arrowId = `${id}-arrow`;
		const btnStyleFn = primary ? primaryBtnStyle : secondaryBtnStyle;

		return (
			<div style={styles.splitButton} data-split-button>
				<button
					type="button"
					style={{
						...btnStyleFn(mainId, isDisabled),
						borderRadius: '4px 0 0 4px',
						whiteSpace: 'nowrap',
					}}
					disabled={isDisabled}
					onClick={onClick}
					onMouseEnter={() => setHoveredBtn(mainId)}
					onMouseLeave={() => setHoveredBtn(null)}
				>
					{isBusy ? busyLabel : `${label}: ${currentLabel}`}
				</button>
				<button
					type="button"
					style={{
						...btnStyleFn(arrowId, isDisabled),
						padding: '8px 8px',
						fontSize: 10,
						borderRadius: '0 4px 4px 0',
						borderLeft: '1px solid rgba(255, 255, 255, 0.2)',
					}}
					disabled={isDisabled}
					aria-label="Select version"
					aria-expanded={isOpen}
					aria-haspopup="menu"
					aria-controls={`split-button-dropdown-${id}`}
					onClick={(e) => {
						e.stopPropagation();
						setDropdownOpen(isOpen ? null : id);
					}}
					onMouseEnter={() => setHoveredBtn(arrowId)}
					onMouseLeave={() => setHoveredBtn(null)}
				>
					&#9662;
				</button>
				{isOpen && (
					<div id={`split-button-dropdown-${id}`} role="menu" style={styles.splitDropdown}>
						{options.map((opt) => {
							const optKey = `${id}-${opt.value}`;
							return (
								<button
									type="button"
									key={opt.value}
									role="menuitem"
									style={optionStyle(optKey, opt.value === currentVersion)}
									onClick={() => {
										onVersionChange(opt.value);
										setDropdownOpen(null);
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											onVersionChange(opt.value);
											setDropdownOpen(null);
										}
										if (e.key === 'Escape') {
											setDropdownOpen(null);
										}
									}}
									onMouseEnter={() => setHoveredOption(optKey)}
									onMouseLeave={() => setHoveredOption(null)}
								>
									{opt.label}
								</button>
							);
						})}
					</div>
				)}
			</div>
		);
	};

	// =========================================================================
	// STATUS INDICATOR
	// =========================================================================

	const statusIndicatorStyle = (state: string): CSSProperties => {
		const base: CSSProperties = {};
		if (state === 'running') {
			return { ...base, color: '#4caf50', fontWeight: 600 };
		}
		if (state === 'starting' || state === 'stopping') {
			return { ...base, color: '#ff9800', fontWeight: 600 };
		}
		if (state === 'stopped') {
			return { ...base, color: 'var(--rr-text-secondary)' };
		}
		// not-installed, no-docker
		return { ...base, color: 'var(--rr-text-secondary)', fontStyle: 'italic' };
	};

	const renderStatusIndicator = (state: string) => (
		<div style={styles.statusRow}>
			<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Status:</span>
			<span style={statusIndicatorStyle(state)}>{stateLabels[state] ?? state}</span>
		</div>
	);

	// =========================================================================
	// SERVICE HANDLERS
	// =========================================================================

	const handleSudoSubmit = () => {
		const password = sudoPasswordInput;
		setSudoPasswordInput('');
		setSudoPromptVisible(false);
		sendMessage({ type: 'sudoPassword', password });
	};

	const handleServiceInstall = () => {
		setServiceBusy(true);
		setServiceAction('install');
		setServiceError(null);
		sendMessage({ type: 'serviceInstall', version: selectedVersion });
	};
	const handleServiceUpdate = () => {
		setServiceBusy(true);
		setServiceAction('update');
		setServiceError(null);
		sendMessage({ type: 'serviceUpdate', version: selectedVersion });
	};
	const handleServiceRemove = () => {
		setServiceBusy(true);
		setServiceAction('remove');
		setServiceError(null);
		sendMessage({ type: 'serviceRemove' });
	};
	const handleServiceStart = () => {
		setServiceBusy(true);
		setServiceAction('start');
		setServiceError(null);
		sendMessage({ type: 'serviceStart' });
	};
	const handleServiceStop = () => {
		setServiceBusy(true);
		setServiceAction('stop');
		setServiceError(null);
		sendMessage({ type: 'serviceStop' });
	};

	// =========================================================================
	// DOCKER HANDLERS
	// =========================================================================

	const handleDockerInstall = () => {
		setDockerBusy(true);
		setDockerAction('install');
		setDockerError(null);
		sendMessage({ type: 'dockerInstall', version: dockerSelectedVersion });
	};
	const handleDockerUpdate = () => {
		setDockerBusy(true);
		setDockerAction('update');
		setDockerError(null);
		sendMessage({ type: 'dockerUpdate', version: dockerSelectedVersion });
	};
	const handleDockerRemove = () => {
		setDockerBusy(true);
		setDockerAction('remove');
		setDockerError(null);
		sendMessage({ type: 'dockerRemove' });
	};
	const handleDockerStart = () => {
		setDockerBusy(true);
		setDockerAction('start');
		setDockerError(null);
		sendMessage({ type: 'dockerStart' });
	};
	const handleDockerStop = () => {
		setDockerBusy(true);
		setDockerAction('stop');
		setDockerError(null);
		sendMessage({ type: 'dockerStop' });
	};

	// =========================================================================
	// INSTALLED ACTION BUTTONS
	// =========================================================================

	const renderInstalledActions = (state: string, isBusy: boolean, onStart: () => void, onStop: () => void, onRemove: () => void, splitButtonId: string, onUpdate: () => void, currentVersion: string, onVersionChange: (v: string) => void, options: { value: string; label: string }[]) => {
		const transitional = state === 'starting' || state === 'stopping';
		const allDisabled = isBusy || transitional;
		const isRunning = state === 'running' || state === 'stopping';
		const startStopId = `${splitButtonId}-startstop`;
		const removeId = `${splitButtonId}-remove`;

		return (
			<>
				<button type="button" style={isRunning ? secondaryBtnStyle(startStopId, allDisabled) : primaryBtnStyle(startStopId, allDisabled)} disabled={allDisabled} onClick={isRunning ? onStop : onStart} onMouseEnter={() => setHoveredBtn(startStopId)} onMouseLeave={() => setHoveredBtn(null)}>
					{state === 'starting' ? 'Starting...' : state === 'stopping' ? 'Stopping...' : isRunning ? 'Stop' : 'Start'}
				</button>
				<button type="button" style={secondaryBtnStyle(removeId, allDisabled)} disabled={allDisabled} onClick={onRemove} onMouseEnter={() => setHoveredBtn(removeId)} onMouseLeave={() => setHoveredBtn(null)}>
					Remove
				</button>
				{renderSplitButton(splitButtonId, 'Update', 'Updating...', onUpdate, isBusy, transitional, currentVersion, onVersionChange, options)}
			</>
		);
	};

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={{ padding: 24, maxWidth: 1200, margin: '0 auto', backgroundColor: 'var(--rr-bg-default)' }}>
			<div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 24, justifyItems: 'center' }}>
				{/* RocketRide Cloud */}
				<div style={styles.panel}>
					{!isDarkTheme && logoDarkUri && <img src={logoDarkUri} alt="RocketRide" style={styles.panelIcon} />}
					{isDarkTheme && logoLightUri && <img src={logoLightUri} alt="RocketRide" style={styles.panelIcon} />}
					<div style={styles.panelContent}>
						<h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: 'var(--rr-text-primary)', letterSpacing: '-0.02em' }}>RocketRide.ai</h1>
						<p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--rr-text-secondary)', margin: 0 }}>Deploy your pipelines to RocketRide.ai cloud or run them on your own infrastructure. Configure your deployment connection in Settings and use this page to deploy.</p>
					</div>
				</div>

				{/* Docker */}
				<div style={styles.panel}>
					{dockerUri && <img src={dockerUri} alt="Docker" style={styles.panelIcon} />}
					<div style={styles.panelContent}>
						<h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: 'var(--rr-text-primary)', letterSpacing: '-0.02em' }}>Docker Container</h1>
						<p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--rr-text-secondary)', margin: 0 }}>Run the RocketRide engine as a Docker container. Requires Docker to be installed and the daemon running.</p>

						{/* Status */}
						{dockerStatus.state !== 'not-installed' && (
							<div style={styles.statusBlock}>
								{renderStatusIndicator(dockerStatus.state)}
								{dockerStatus.version && (
									<div style={styles.statusRow}>
										<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Version:</span>
										<span>
											{displayVersion(dockerStatus.version)}
											{dockerStatus.publishedAt ? ` (${new Date(dockerStatus.publishedAt).toLocaleDateString()})` : ''}
										</span>
									</div>
								)}
								{dockerStatus.imageTag && (
									<div style={styles.statusRow}>
										<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Image:</span>
										<span style={{ fontFamily: 'var(--vscode-editor-font-family)', fontSize: 12, opacity: 0.8 }}>
											{IMAGE_BASE}:{dockerStatus.imageTag}
										</span>
									</div>
								)}
							</div>
						)}

						{/* Progress / Error */}
						{dockerProgress && <div style={{ fontSize: 11, fontFamily: 'var(--vscode-editor-font-family)', color: 'var(--rr-text-secondary)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{dockerProgress}</div>}
						{dockerError && <div style={{ fontSize: 12, color: 'var(--rr-color-error)', marginTop: 4 }}>{dockerError}</div>}

						{/* Actions */}
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>{dockerStatus.state === 'no-docker' ? <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--rr-text-secondary)', margin: 0, fontStyle: 'italic', marginTop: 4 }}>Docker is not installed or the Docker daemon is not running.</p> : dockerStatus.state === 'not-installed' && !(dockerBusy && dockerAction === 'remove') ? renderSplitButton('docker-install', 'Install', 'Installing...', handleDockerInstall, dockerBusy, false, dockerSelectedVersion, setDockerSelectedVersion, dockerVersionOptions) : renderInstalledActions(dockerStatus.state, dockerBusy, handleDockerStart, handleDockerStop, handleDockerRemove, 'docker-update', handleDockerUpdate, dockerSelectedVersion, setDockerSelectedVersion, dockerVersionOptions)}</div>
					</div>
				</div>

				{/* On-Premises Service */}
				<div style={styles.panel}>
					{onpremUri && <img src={onpremUri} alt="Local Service" style={styles.panelIcon} />}
					<div style={styles.panelContent}>
						<h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: 'var(--rr-text-primary)', letterSpacing: '-0.02em' }}>Local Service</h1>
						<p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--rr-text-secondary)', margin: 0 }}>Install as a system service on this machine. The service runs independently and starts automatically on boot.</p>

						{/* Status -- only shown when installed */}
						{serviceStatus.state !== 'not-installed' && (
							<div style={styles.statusBlock}>
								{renderStatusIndicator(serviceStatus.state)}
								{serviceStatus.version && (
									<div style={styles.statusRow}>
										<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Version:</span>
										<span>
											{displayVersion(serviceStatus.version)}
											{serviceStatus.publishedAt ? ` (${new Date(serviceStatus.publishedAt).toLocaleDateString()})` : ''}
										</span>
									</div>
								)}
								{serviceStatus.installPath && (
									<div style={styles.statusRow}>
										<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Location:</span>
										<span style={{ fontFamily: 'var(--vscode-editor-font-family)', fontSize: 12, opacity: 0.8 }}>{serviceStatus.installPath}</span>
									</div>
								)}
							</div>
						)}

						{/* Progress / Error / Sudo prompt */}
						{sudoPromptVisible ? (
							<div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
								<label style={{ fontSize: 12, color: 'var(--rr-text-secondary)' }}>Enter your sudo password:</label>
								<div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
									<input
										type="password"
										style={{
											flex: 1,
											padding: '5px 8px',
											fontSize: 13,
											border: '1px solid var(--rr-border-input)',
											backgroundColor: 'var(--rr-bg-input)',
											color: 'var(--rr-text-primary)',
											borderRadius: 4,
											minWidth: 0,
										}}
										value={sudoPasswordInput}
										onChange={(e) => setSudoPasswordInput(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Enter' && sudoPasswordInput) handleSudoSubmit();
										}}
										autoFocus
									/>
									<button type="button" style={primaryBtnStyle('sudo-continue', !sudoPasswordInput)} onClick={handleSudoSubmit} disabled={!sudoPasswordInput} onMouseEnter={() => setHoveredBtn('sudo-continue')} onMouseLeave={() => setHoveredBtn(null)}>
										Continue
									</button>
								</div>
							</div>
						) : (
							<>
								{serviceProgress && <div style={{ fontSize: 11, fontFamily: 'var(--vscode-editor-font-family)', color: 'var(--rr-text-secondary)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{serviceProgress}</div>}
								{serviceError && <div style={{ fontSize: 12, color: 'var(--rr-color-error)', marginTop: 4 }}>{serviceError}</div>}
							</>
						)}

						{/* Actions */}
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>{serviceStatus.state === 'not-installed' && !(serviceBusy && serviceAction === 'remove') ? renderSplitButton('service-install', 'Install', 'Installing...', handleServiceInstall, serviceBusy, false, selectedVersion, setSelectedVersion, serviceVersionOptions) : renderInstalledActions(serviceStatus.state, serviceBusy, handleServiceStart, handleServiceStop, handleServiceRemove, 'service-update', handleServiceUpdate, selectedVersion, setSelectedVersion, serviceVersionOptions)}</div>
					</div>
				</div>
			</div>
		</div>
	);
};
