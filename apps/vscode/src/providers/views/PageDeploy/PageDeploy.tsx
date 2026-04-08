// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useState, useEffect } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';

import '../../styles/vscode.css';
import '../../styles/app.css';
import './styles.css';

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

type IncomingMessage =
	| { type: 'init'; rocketrideLogoDarkUri?: string; rocketrideLogoLightUri?: string; dockerIconUri?: string; onpremIconUri?: string }
	| { type: 'serviceStatus'; status: ServiceStatus }
	| { type: 'dockerStatus'; status: DockerStatus }
	| { type: 'versionsLoaded'; versions: VersionItem[] }
	| { type: 'dockerVersionsLoaded'; tags: string[] }
	| { type: 'serviceProgress'; message: string }
	| { type: 'serviceComplete' }
	| { type: 'serviceError'; message: string }
	| { type: 'serviceNeedsSudo' }
	| { type: 'dockerProgress'; message: string }
	| { type: 'dockerComplete' }
	| { type: 'dockerError'; message: string };

type OutgoingMessage =
	| { type: 'ready' }
	| { type: 'copyToClipboard'; text: string }
	| { type: 'fetchVersions' }
	| { type: 'serviceInstall'; version: string }
	| { type: 'serviceRemove' }
	| { type: 'serviceUpdate'; version: string }
	| { type: 'serviceStart' }
	| { type: 'serviceStop' }
	| { type: 'sudoPassword'; password: string }
	| { type: 'dockerInstall'; version: string }
	| { type: 'dockerRemove' }
	| { type: 'dockerUpdate'; version: string }
	| { type: 'dockerStart' }
	| { type: 'dockerStop' };

const displayVersion = (tag: string): string => {
	if (tag === 'latest') return 'Latest';
	if (tag === 'prerelease') return 'Prerelease';
	return tag.replace(/^server-/, '');
};

const stateLabels: Record<string, string> = {
	'not-installed': '○ Not installed',
	'no-docker': '○ Docker unavailable',
	'starting': '◐ Starting...',
	'running': '● Running',
	'stopping': '◐ Stopping...',
	'stopped': '○ Stopped',
};

export const PageDeploy: React.FC = () => {
	const [logoDarkUri, setLogoDarkUri] = useState<string | undefined>();
	const [logoLightUri, setLogoLightUri] = useState<string | undefined>();
	const [dockerUri, setDockerUri] = useState<string | undefined>();
	const [onpremUri, setOnpremUri] = useState<string | undefined>();

	// Service state
	const [serviceStatus, setServiceStatus] = useState<ServiceStatus>({
		state: 'not-installed' as const, version: null, publishedAt: null, installPath: null
	});
	const [serviceProgress, setServiceProgress] = useState<string | null>(null);
	const [serviceError, setServiceError] = useState<string | null>(null);
	const [serviceBusy, setServiceBusy] = useState(false);
	const [serviceAction, setServiceAction] = useState<'install' | 'update' | 'remove' | 'start' | 'stop' | null>(null);
	const [sudoPromptVisible, setSudoPromptVisible] = useState(false);
	const [sudoPasswordInput, setSudoPasswordInput] = useState('');

	// Docker state
	const [dockerStatus, setDockerStatus] = useState<DockerStatus>({
		state: 'not-installed' as const, version: null, publishedAt: null, imageTag: null
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
		}
	});

	useEffect(() => {
		sendMessage({ type: 'ready' });
		sendMessage({ type: 'fetchVersions' });
	}, [sendMessage]);

	// =========================================================================
	// Version options (separate for each panel)
	// =========================================================================

	// Service panel: GitHub Releases
	const serviceVersionOptions = [
		{ value: 'latest', label: '<Latest>' },
		{ value: 'prerelease', label: '<Prerelease>' },
		...versions.map(v => ({ value: v.tag_name, label: displayVersion(v.tag_name) }))
	];

	// Docker panel: GHCR image tags
	const dockerVersionOptions = [
		{ value: 'latest', label: '<Latest>' },
		{ value: 'prerelease', label: '<Prerelease>' },
		...dockerTags.map(t => ({ value: t, label: t }))
	];

	// =========================================================================
	// Split button (reusable for both panels)
	// =========================================================================

	const [dropdownOpen, setDropdownOpen] = useState<string | null>(null);
	// Close dropdown on outside click — single document listener, cleaned up properly
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (!target.parentElement?.closest('.split-button')) {
				setDropdownOpen(null);
			}
		};
		document.addEventListener('click', handler);
		return () => document.removeEventListener('click', handler);
	}, []);

	const renderSplitButton = (
		id: string,
		label: string,
		busyLabel: string,
		onClick: () => void,
		isBusy: boolean,
		isTransitional: boolean,
		currentVersion: string,
		onVersionChange: (v: string) => void,
		options: { value: string; label: string }[],
		primary: boolean = true
	) => {
		const isOpen = dropdownOpen === id;
		const btnClass = primary ? 'deploy-panel-btn-primary' : 'deploy-panel-btn-secondary';
		const isDisabled = isBusy || isTransitional;
		const currentLabel = options.find(v => v.value === currentVersion)?.label ?? '<Latest>';

		return (
			<div className="split-button">
				<button
					type="button"
					className={`split-button-main ${btnClass}`}
					disabled={isDisabled}
					onClick={onClick}
				>
					{isBusy ? busyLabel : `${label}: ${currentLabel}`}
				</button>
				<button
					type="button"
					className={`split-button-arrow ${btnClass}`}
					disabled={isDisabled}
					aria-label="Select version"
					aria-expanded={isOpen}
					aria-haspopup="menu"
					aria-controls={`split-button-dropdown-${id}`}
					onClick={(e) => { e.stopPropagation(); setDropdownOpen(isOpen ? null : id); }}
				>
					&#9662;
				</button>
				{isOpen && (
					<div
						id={`split-button-dropdown-${id}`}
						role="menu"
						className="split-button-dropdown"
					>
						{options.map((opt) => (
							<button
								type="button"
								key={opt.value}
								role="menuitem"
								className={`split-button-option ${opt.value === currentVersion ? 'selected' : ''}`}
								onClick={() => { onVersionChange(opt.value); setDropdownOpen(null); }}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') { onVersionChange(opt.value); setDropdownOpen(null); }
									if (e.key === 'Escape') { setDropdownOpen(null); }
								}}
							>
								{opt.label}
							</button>
						))}
					</div>
				)}
			</div>
		);
	};

	// =========================================================================
	// Status display (reusable)
	// =========================================================================

	const renderStatusIndicator = (state: string) => (
		<div className="service-status-row">
			<span className="service-status-label">Status:</span>
			<span className={`service-status-indicator ${state}`}>
				{stateLabels[state] ?? state}
			</span>
		</div>
	);

	// =========================================================================
	// Service handlers
	// =========================================================================

	const handleSudoSubmit = () => {
		const password = sudoPasswordInput;
		setSudoPasswordInput('');
		setSudoPromptVisible(false);
		sendMessage({ type: 'sudoPassword', password });
	};

	const handleServiceInstall = () => {
		setServiceBusy(true); setServiceAction('install'); setServiceError(null);
		sendMessage({ type: 'serviceInstall', version: selectedVersion });
	};
	const handleServiceUpdate = () => {
		setServiceBusy(true); setServiceAction('update'); setServiceError(null);
		sendMessage({ type: 'serviceUpdate', version: selectedVersion });
	};
	const handleServiceRemove = () => {
		setServiceBusy(true); setServiceAction('remove'); setServiceError(null);
		sendMessage({ type: 'serviceRemove' });
	};
	const handleServiceStart = () => {
		setServiceBusy(true); setServiceAction('start'); setServiceError(null);
		sendMessage({ type: 'serviceStart' });
	};
	const handleServiceStop = () => {
		setServiceBusy(true); setServiceAction('stop'); setServiceError(null);
		sendMessage({ type: 'serviceStop' });
	};

	// =========================================================================
	// Docker handlers
	// =========================================================================

	const handleDockerInstall = () => {
		setDockerBusy(true); setDockerAction('install'); setDockerError(null);
		sendMessage({ type: 'dockerInstall', version: dockerSelectedVersion });
	};
	const handleDockerUpdate = () => {
		setDockerBusy(true); setDockerAction('update'); setDockerError(null);
		sendMessage({ type: 'dockerUpdate', version: dockerSelectedVersion });
	};
	const handleDockerRemove = () => {
		setDockerBusy(true); setDockerAction('remove'); setDockerError(null);
		sendMessage({ type: 'dockerRemove' });
	};
	const handleDockerStart = () => {
		setDockerBusy(true); setDockerAction('start'); setDockerError(null);
		sendMessage({ type: 'dockerStart' });
	};
	const handleDockerStop = () => {
		setDockerBusy(true); setDockerAction('stop'); setDockerError(null);
		sendMessage({ type: 'dockerStop' });
	};

	// =========================================================================
	// Installed action buttons (reusable)
	// =========================================================================

	const renderInstalledActions = (
		state: string,
		isBusy: boolean,
		onStart: () => void,
		onStop: () => void,
		onRemove: () => void,
		splitButtonId: string,
		onUpdate: () => void,
		currentVersion: string,
		onVersionChange: (v: string) => void,
		options: { value: string; label: string }[]
	) => {
		const transitional = state === 'starting' || state === 'stopping';
		const allDisabled = isBusy || transitional;
		const isRunning = state === 'running' || state === 'stopping';

		return (
			<>
				<button
					type="button"
					className={`deploy-panel-btn ${isRunning ? 'deploy-panel-btn-secondary' : 'deploy-panel-btn-primary'}`}
					disabled={allDisabled}
					onClick={isRunning ? onStop : onStart}
				>
					{state === 'starting' ? 'Starting...' : state === 'stopping' ? 'Stopping...' : isRunning ? 'Stop' : 'Start'}
				</button>
				<button type="button" className="deploy-panel-btn deploy-panel-btn-secondary" disabled={allDisabled} onClick={onRemove}>
					Remove
				</button>
				{renderSplitButton(splitButtonId, 'Update', 'Updating...', onUpdate, isBusy, transitional, currentVersion, onVersionChange, options)}
			</>
		);
	};

	return (
		<div className="deploy-app">
			<div className="deploy-panels">
				{/* RocketRide Cloud */}
				<div className="deploy-panel deploy-panel-rocketride">
					{logoDarkUri && <img src={logoDarkUri} alt="RocketRide" className="deploy-panel-logo logo-dark" />}
					{logoLightUri && <img src={logoLightUri} alt="RocketRide" className="deploy-panel-logo logo-light" />}
					<div className="deploy-panel-content">
						<h1 className="deploy-panel-title">RocketRide.ai</h1>
						<p className="deploy-panel-description">
							Deploy your pipelines to RocketRide.ai cloud or run them on your own infrastructure.
							Configure your deployment connection in Settings and use this page to deploy.
						</p>
					</div>
				</div>

				{/* Docker */}
				<div className="deploy-panel deploy-panel-docker">
					{dockerUri && (
						<img src={dockerUri} alt="Docker" className="deploy-panel-icon" />
					)}
					<div className="deploy-panel-content">
						<h1 className="deploy-panel-title">Docker Container</h1>
						<p className="deploy-panel-description">
							Run the RocketRide engine as a Docker container.
							Requires Docker to be installed and the daemon running.
						</p>

						{/* Status */}
						{dockerStatus.state !== 'not-installed' && (
							<div className="service-status">
								{renderStatusIndicator(dockerStatus.state)}
								{dockerStatus.version && (
									<div className="service-status-row">
										<span className="service-status-label">Version:</span>
										<span>{displayVersion(dockerStatus.version)}{dockerStatus.publishedAt ? ` (${new Date(dockerStatus.publishedAt).toLocaleDateString()})` : ''}</span>
									</div>
								)}
								{dockerStatus.imageTag && (
									<div className="service-status-row">
										<span className="service-status-label">Image:</span>
										<span className="service-status-path">{IMAGE_BASE}:{dockerStatus.imageTag}</span>
									</div>
								)}
							</div>
						)}

						{/* Progress / Error */}
						{dockerProgress && (
							<div className="service-progress">{dockerProgress}</div>
						)}
						{dockerError && (
							<div className="service-error">{dockerError}</div>
						)}

						{/* Actions */}
						<div className="deploy-panel-actions">
							{dockerStatus.state === 'no-docker' ? (
								<p className="deploy-panel-description docker-unavailable">
									Docker is not installed or the Docker daemon is not running.
								</p>
							) : dockerStatus.state === 'not-installed' && !(dockerBusy && dockerAction === 'remove') ? (
								renderSplitButton(
									'docker-install', 'Install', 'Installing...',
									handleDockerInstall, dockerBusy, false,
									dockerSelectedVersion, setDockerSelectedVersion,
									dockerVersionOptions
								)
							) : (
								renderInstalledActions(
									dockerStatus.state, dockerBusy,
									handleDockerStart, handleDockerStop, handleDockerRemove,
									'docker-update', handleDockerUpdate,
									dockerSelectedVersion, setDockerSelectedVersion,
									dockerVersionOptions
								)
							)}
						</div>
					</div>
				</div>

				{/* On-Premises Service */}
				<div className="deploy-panel deploy-panel-onprem">
					{onpremUri && (
						<img src={onpremUri} alt="Local Service" className="deploy-panel-icon" />
					)}
					<div className="deploy-panel-content">
						<h1 className="deploy-panel-title">Local Service</h1>
						<p className="deploy-panel-description">
							Install as a system service on this machine.
							The service runs independently and starts automatically on boot.
						</p>

						{/* Status — only shown when installed */}
						{serviceStatus.state !== 'not-installed' && (
							<div className="service-status">
								{renderStatusIndicator(serviceStatus.state)}
								{serviceStatus.version && (
									<div className="service-status-row">
										<span className="service-status-label">Version:</span>
										<span>{displayVersion(serviceStatus.version)}{serviceStatus.publishedAt ? ` (${new Date(serviceStatus.publishedAt).toLocaleDateString()})` : ''}</span>
									</div>
								)}
								{serviceStatus.installPath && (
									<div className="service-status-row">
										<span className="service-status-label">Location:</span>
										<span className="service-status-path">{serviceStatus.installPath}</span>
									</div>
								)}
							</div>
						)}

						{/* Progress / Error / Sudo prompt */}
						{sudoPromptVisible ? (
							<div className="sudo-prompt">
								<label className="sudo-prompt-label">Enter your sudo password:</label>
								<div className="sudo-prompt-row">
									<input
										type="password"
										className="sudo-prompt-input"
										value={sudoPasswordInput}
										onChange={e => setSudoPasswordInput(e.target.value)}
										onKeyDown={e => { if (e.key === 'Enter' && sudoPasswordInput) handleSudoSubmit(); }}
										autoFocus
									/>
									<button
										type="button"
										className="split-button-main deploy-panel-btn-primary"
										onClick={handleSudoSubmit}
										disabled={!sudoPasswordInput}
									>
										Continue
									</button>
								</div>
							</div>
						) : (
							<>
								{serviceProgress && (
									<div className="service-progress">{serviceProgress}</div>
								)}
								{serviceError && (
									<div className="service-error">{serviceError}</div>
								)}
							</>
						)}

						{/* Actions */}
						<div className="deploy-panel-actions">
							{serviceStatus.state === 'not-installed' && !(serviceBusy && serviceAction === 'remove') ? (
								renderSplitButton(
									'service-install', 'Install', 'Installing...',
									handleServiceInstall, serviceBusy, false,
									selectedVersion, setSelectedVersion,
									serviceVersionOptions
								)
							) : (
								renderInstalledActions(
									serviceStatus.state, serviceBusy,
									handleServiceStart, handleServiceStop, handleServiceRemove,
									'service-update', handleServiceUpdate,
									selectedVersion, setSelectedVersion,
									serviceVersionOptions
								)
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

const IMAGE_BASE = 'ghcr.io/rocketride-org/rocketride-engine';
