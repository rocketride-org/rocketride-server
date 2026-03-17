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

interface VersionItem {
	tag_name: string;
	prerelease: boolean;
}

type IncomingMessage =
	| { type: 'init'; rocketrideLogoDarkUri?: string; rocketrideLogoLightUri?: string; dockerIconUri?: string; onpremIconUri?: string; engineImage?: string }
	| { type: 'serviceStatus'; status: ServiceStatus }
	| { type: 'versionsLoaded'; versions: VersionItem[] }
	| { type: 'serviceProgress'; message: string }
	| { type: 'serviceComplete' }
	| { type: 'serviceError'; message: string };

type OutgoingMessage =
	| { type: 'ready' }
	| { type: 'copyToClipboard'; text: string }
	| { type: 'dockerDeployLocal' }
	| { type: 'fetchVersions' }
	| { type: 'serviceInstall'; version: string }
	| { type: 'serviceRemove' }
	| { type: 'serviceUpdate'; version: string }
	| { type: 'serviceStart' }
	| { type: 'serviceStop' };

const displayVersion = (tag: string): string => tag.replace(/^server-/, '');

export const PageDeploy: React.FC = () => {
	const [logoDarkUri, setLogoDarkUri] = useState<string | undefined>();
	const [logoLightUri, setLogoLightUri] = useState<string | undefined>();
	const [dockerUri, setDockerUri] = useState<string | undefined>();
	const [onpremUri, setOnpremUri] = useState<string | undefined>();
	const [engineImage, setEngineImage] = useState('ghcr.io/rocketride-org/rocketride-engine:latest');
	const [deploying, setDeploying] = useState(false);

	// Service state
	const [serviceStatus, setServiceStatus] = useState<ServiceStatus>({
		state: 'not-installed' as const, version: null, publishedAt: null, installPath: null
	});
	const [versions, setVersions] = useState<VersionItem[]>([]);
	const [versionsLoading, setVersionsLoading] = useState(false);
	const [selectedVersion, setSelectedVersion] = useState('latest');
	const [serviceProgress, setServiceProgress] = useState<string | null>(null);
	const [serviceError, setServiceError] = useState<string | null>(null);
	const [serviceBusy, setServiceBusy] = useState(false);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (message) => {
			switch (message.type) {
				case 'init':
					if (message.rocketrideLogoDarkUri) setLogoDarkUri(message.rocketrideLogoDarkUri);
					if (message.rocketrideLogoLightUri) setLogoLightUri(message.rocketrideLogoLightUri);
					if (message.dockerIconUri) setDockerUri(message.dockerIconUri);
					if (message.onpremIconUri) setOnpremUri(message.onpremIconUri);
					if (message.engineImage) setEngineImage(message.engineImage);
					break;
				case 'serviceStatus':
					setServiceStatus(message.status);
					// Don't clear progress/busy during polling — only clear when no operation is active
					if (!serviceBusy) {
						setServiceProgress(null);
					}
					break;
				case 'versionsLoaded':
					setVersions(message.versions);
					setVersionsLoading(false);
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
			}
		}
	});

	useEffect(() => {
		sendMessage({ type: 'ready' });
		setVersionsLoading(true);
		sendMessage({ type: 'fetchVersions' });
	}, [sendMessage]);

	const remoteCommands = `docker pull ${engineImage}\ndocker create --name rocketride-engine -p 5565:5565 ${engineImage}`;

	const handleInstall = () => {
		setServiceBusy(true);
		setServiceError(null);
		sendMessage({ type: 'serviceInstall', version: selectedVersion });
	};

	const handleUpdate = () => {
		setServiceBusy(true);
		setServiceError(null);
		sendMessage({ type: 'serviceUpdate', version: selectedVersion });
	};

	const handleRemove = () => {
		setServiceBusy(true);
		setServiceError(null);
		sendMessage({ type: 'serviceRemove' });
	};

	const handleStart = () => {
		setServiceBusy(true);
		setServiceError(null);
		sendMessage({ type: 'serviceStart' });
	};

	const handleStop = () => {
		setServiceBusy(true);
		setServiceError(null);
		sendMessage({ type: 'serviceStop' });
	};

	// Split button: primary action on the left, dropdown arrow on the right
	const [dropdownOpen, setDropdownOpen] = useState<string | null>(null); // 'install' or 'update' or null

	const versionOptions = [
		{ value: 'latest', label: '<Latest>' },
		{ value: 'prerelease', label: '<Prerelease>' },
		...versions.map(v => ({ value: v.tag_name, label: displayVersion(v.tag_name) }))
	];

	const selectedLabel = versionOptions.find(v => v.value === selectedVersion)?.label ?? '<Latest>';

	const renderSplitButton = (
		id: string,
		label: string,
		busyLabel: string,
		onClick: () => void,
		primary: boolean = true
	) => {
		const isOpen = dropdownOpen === id;
		const btnClass = primary ? 'deploy-panel-btn-primary' : 'deploy-panel-btn-secondary';
		const transitional = ['starting', 'stopping'].includes(serviceStatus.state);
		const isDisabled = serviceBusy || transitional;

		return (
			<div className="split-button" ref={el => {
				// Close dropdown on outside click
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
					{serviceBusy ? busyLabel : `${label}: ${selectedLabel}`}
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
						{versionOptions.map((opt, i) => (
							<div
								key={opt.value}
								className={`split-button-option ${opt.value === selectedVersion ? 'selected' : ''}`}
								onClick={() => { setSelectedVersion(opt.value); setDropdownOpen(null); }}
							>
								{opt.label}
							</div>
						))}
					</div>
				)}
			</div>
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
						<h1 className="deploy-panel-title">Deploy Image</h1>
						<p className="deploy-panel-description">
							Download the RocketRide engine image and create a container.
							Requires Docker to be installed.
						</p>
						<div className="deploy-panel-actions">
							<button
								type="button"
								className="deploy-panel-btn deploy-panel-btn-primary"
								disabled={deploying}
								onClick={() => {
									setDeploying(true);
									sendMessage({ type: 'dockerDeployLocal' });
								}}
							>
								{deploying ? 'Image deployed' : 'Deploy locally'}
							</button>
						</div>
						<details className="deploy-panel-details">
							<summary>Deploy to a remote server</summary>
							<div className="deploy-panel-commands">
								<p className="deploy-panel-description">
									Run these commands on your target server to pull the image and create a container:
								</p>
								<pre className="deploy-panel-code"><code>{remoteCommands}</code></pre>
								<button
									type="button"
									className="deploy-panel-copy"
									onClick={() => sendMessage({ type: 'copyToClipboard', text: remoteCommands })}
								>
									Copy commands
								</button>
							</div>
						</details>
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
								<div className="service-status-row">
									<span className="service-status-label">Status:</span>
									<span className={`service-status-indicator ${serviceStatus.state}`}>
										{{
											'not-installed': '○ Not installed',
											'starting': '◐ Starting...',
											'running': '● Running',
											'stopping': '◐ Stopping...',
											'stopped': '○ Stopped',
										}[serviceStatus.state]}
									</span>
								</div>
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
								renderSplitButton('install', 'Install', 'Installing...', handleInstall)
							) : (() => {
								const transitional = serviceStatus.state === 'starting' || serviceStatus.state === 'stopping';
								const allDisabled = serviceBusy || transitional;
								const isRunning = serviceStatus.state === 'running' || serviceStatus.state === 'stopping';

								return (
									<>
										<button
											type="button"
											className={`deploy-panel-btn ${isRunning ? 'deploy-panel-btn-secondary' : 'deploy-panel-btn-primary'}`}
											disabled={allDisabled}
											onClick={isRunning ? handleStop : handleStart}
										>
											{serviceStatus.state === 'starting' ? 'Starting...' : serviceStatus.state === 'stopping' ? 'Stopping...' : isRunning ? 'Stop' : 'Start'}
										</button>
										<button type="button" className="deploy-panel-btn deploy-panel-btn-secondary" disabled={allDisabled} onClick={handleRemove}>
											Remove
										</button>
										{renderSplitButton('update', 'Update', 'Updating...', handleUpdate)}
									</>
								);
							})()}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
