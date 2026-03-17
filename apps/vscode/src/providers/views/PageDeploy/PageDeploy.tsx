// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useState, useEffect } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';

import '../../styles/vscode.css';
import '../../styles/app.css';
import './styles.css';

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

	// Docker state
	const [dockerStatus, setDockerStatus] = useState<DockerStatus>({
		state: 'not-installed' as const, version: null, publishedAt: null, imageTag: null
	});
	const [dockerProgress, setDockerProgress] = useState<string | null>(null);
	const [dockerError, setDockerError] = useState<string | null>(null);
	const [dockerBusy, setDockerBusy] = useState(false);

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
				case 'serviceProgress':
					setServiceProgress(message.message);
					setServiceError(null);
					break;
				case 'serviceComplete':
					setServiceBusy(false);
					setServiceProgress(null);
					break;
				case 'serviceError':
					setServiceError(message.message);
					setServiceBusy(false);
					setServiceProgress(null);
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
					setDockerProgress(null);
					break;
				case 'dockerError':
					setDockerError(message.message);
					setDockerBusy(false);
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
		setVersionsLoading(true);
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
			<div className="split-button" ref={el => {
				if (!el) return;
				const handler = (e: MouseEvent) => {
					if (!el.contains(e.target as Node)) setDropdownOpen(null);
				};
				document.addEventListener('click', handler);
				return () => document.removeEventListener('click', handler);
			}}>
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
					onClick={(e) => { e.stopPropagation(); setDropdownOpen(isOpen ? null : id); }}
				>
					&#9662;
				</button>
				{isOpen && (
					<div className="split-button-dropdown">
						{options.map((opt) => (
							<div
								key={opt.value}
								className={`split-button-option ${opt.value === currentVersion ? 'selected' : ''}`}
								onClick={() => { onVersionChange(opt.value); setDropdownOpen(null); }}
							>
								{opt.label}
							</div>
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

	const handleServiceInstall = () => {
		setServiceBusy(true); setServiceError(null);
		sendMessage({ type: 'serviceInstall', version: selectedVersion });
	};
	const handleServiceUpdate = () => {
		setServiceBusy(true); setServiceError(null);
		sendMessage({ type: 'serviceUpdate', version: selectedVersion });
	};
	const handleServiceRemove = () => {
		setServiceBusy(true); setServiceError(null);
		sendMessage({ type: 'serviceRemove' });
	};
	const handleServiceStart = () => {
		setServiceBusy(true); setServiceError(null);
		sendMessage({ type: 'serviceStart' });
	};
	const handleServiceStop = () => {
		setServiceBusy(true); setServiceError(null);
		sendMessage({ type: 'serviceStop' });
	};

	// =========================================================================
	// Docker handlers
	// =========================================================================

	const handleDockerInstall = () => {
		setDockerBusy(true); setDockerError(null);
		sendMessage({ type: 'dockerInstall', version: dockerSelectedVersion });
	};
	const handleDockerUpdate = () => {
		setDockerBusy(true); setDockerError(null);
		sendMessage({ type: 'dockerUpdate', version: dockerSelectedVersion });
	};
	const handleDockerRemove = () => {
		setDockerBusy(true); setDockerError(null);
		sendMessage({ type: 'dockerRemove' });
	};
	const handleDockerStart = () => {
		setDockerBusy(true); setDockerError(null);
		sendMessage({ type: 'dockerStart' });
	};
	const handleDockerStop = () => {
		setDockerBusy(true); setDockerError(null);
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
							) : dockerStatus.state === 'not-installed' ? (
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

						{/* Progress / Error */}
						{serviceProgress && (
							<div className="service-progress">{serviceProgress}</div>
						)}
						{serviceError && (
							<div className="service-error">{serviceError}</div>
						)}

						{/* Actions */}
						<div className="deploy-panel-actions">
							{serviceStatus.state === 'not-installed' ? (
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
