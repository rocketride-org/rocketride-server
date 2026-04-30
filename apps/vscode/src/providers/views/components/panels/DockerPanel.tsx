// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DockerPanel — target panel for Docker connection mode.
 *
 * Shows container status, version, image tag, and action buttons
 * (Install/Start/Stop/Remove/Update with version dropdown).
 *
 * Used by ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React, { useState, useEffect } from 'react';
import dockerIcon from '../../../../../docker.svg';
import { DockerStatus, VersionOption, displayVersion, stateLabels, IMAGE_BASE, panelStyles as S, statusIndicatorStyle, primaryBtnStyle, secondaryBtnStyle, optionStyle } from './shared';

// =============================================================================
// TYPES
// =============================================================================

export interface DockerPanelProps {
	idPrefix: string;
	status: DockerStatus;
	progress: string | null;
	error: string | null;
	busy: boolean;
	action: 'install' | 'update' | 'remove' | 'start' | 'stop' | null;
	versions: VersionOption[];
	selectedVersion: string;
	onVersionChange: (version: string) => void;
	onInstall: () => void;
	onUpdate: () => void;
	onRemove: () => void;
	onStart: () => void;
	onStop: () => void;
	simplified?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const DockerPanel: React.FC<DockerPanelProps> = ({ idPrefix, status, progress, error, busy, action, versions, selectedVersion, onVersionChange, onInstall, onUpdate, onRemove, onStart, onStop }) => {
	const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
	const [hoveredOption, setHoveredOption] = useState<string | null>(null);
	const [dropdownOpen, setDropdownOpen] = useState(false);

	// Close dropdown on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target.closest(`[data-split-button="${idPrefix}-docker"]`)) {
				setDropdownOpen(false);
			}
		};
		document.addEventListener('click', handler);
		return () => document.removeEventListener('click', handler);
	}, [idPrefix]);

	const transitional = status.state === 'starting' || status.state === 'stopping';
	const allDisabled = busy || transitional;
	const isRunning = status.state === 'running' || status.state === 'stopping';
	const showInstall = status.state === 'not-installed' && !(busy && action === 'remove');

	// =========================================================================
	// SPLIT BUTTON
	// =========================================================================

	const renderSplitButton = (label: string, busyLabel: string, onClick: () => void, primary: boolean = true) => {
		const currentLabel = versions.find((v) => v.value === selectedVersion)?.label ?? '<Latest>';
		const btnStyle = primary ? primaryBtnStyle : secondaryBtnStyle;
		const mainId = `${idPrefix}-docker-main`;
		const arrowId = `${idPrefix}-docker-arrow`;

		return (
			<div style={S.splitButton} data-split-button={`${idPrefix}-docker`}>
				<button type="button" style={{ ...btnStyle(hoveredBtn === mainId, allDisabled), borderRadius: '4px 0 0 4px', whiteSpace: 'nowrap' }} disabled={allDisabled} onClick={onClick} onMouseEnter={() => setHoveredBtn(mainId)} onMouseLeave={() => setHoveredBtn(null)}>
					{busy ? busyLabel : `${label}: ${currentLabel}`}
				</button>
				<button
					type="button"
					style={{
						...btnStyle(hoveredBtn === arrowId, allDisabled),
						padding: '8px 8px',
						fontSize: 10,
						borderRadius: '0 4px 4px 0',
						borderLeft: '1px solid rgba(255, 255, 255, 0.2)',
					}}
					disabled={allDisabled}
					aria-label="Select version"
					aria-expanded={dropdownOpen}
					aria-haspopup="menu"
					onClick={(e) => {
						e.stopPropagation();
						setDropdownOpen(!dropdownOpen);
					}}
					onMouseEnter={() => setHoveredBtn(arrowId)}
					onMouseLeave={() => setHoveredBtn(null)}
				>
					&#9662;
				</button>
				{dropdownOpen && (
					<div role="menu" style={S.splitDropdown}>
						{versions.map((opt) => {
							const optKey = `${idPrefix}-docker-${opt.value}`;
							return (
								<button
									type="button"
									key={opt.value}
									role="menuitem"
									style={optionStyle(opt.value === selectedVersion, hoveredOption === optKey)}
									onClick={() => {
										onVersionChange(opt.value);
										setDropdownOpen(false);
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											onVersionChange(opt.value);
											setDropdownOpen(false);
										}
										if (e.key === 'Escape') setDropdownOpen(false);
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
	// RENDER
	// =========================================================================

	return (
		<>
			<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
				<img src={dockerIcon} alt="Docker" style={{ width: 48, height: 48, objectFit: 'contain', flexShrink: 0 }} />
				<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>Run the RocketRide engine as a Docker container. Requires Docker to be installed and the daemon running.</div>
			</div>

			{/* Status */}
			{status.state !== 'not-installed' && (
				<div style={S.statusBlock}>
					<div style={S.statusRow}>
						<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Status:</span>
						<span style={statusIndicatorStyle(status.state)}>{stateLabels[status.state] ?? status.state}</span>
					</div>
					{status.version && (
						<div style={S.statusRow}>
							<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Version:</span>
							<span>
								{displayVersion(status.version)}
								{status.publishedAt ? ` (${new Date(status.publishedAt).toLocaleDateString()})` : ''}
							</span>
						</div>
					)}
					{status.imageTag && (
						<div style={S.statusRow}>
							<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Image:</span>
							<span style={{ fontFamily: 'var(--vscode-editor-font-family)', fontSize: 12, opacity: 0.8 }}>
								{IMAGE_BASE}:{status.imageTag}
							</span>
						</div>
					)}
				</div>
			)}

			{/* Progress / Error */}
			{progress && <div style={S.progress}>{progress}</div>}
			{error && <div style={S.error}>{error}</div>}

			{/* Actions */}
			<div style={S.actions}>
				{status.state === 'no-docker' ? (
					<p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--rr-text-secondary)', margin: 0, fontStyle: 'italic', marginTop: 4 }}>Docker is not installed or the Docker daemon is not running.</p>
				) : showInstall ? (
					renderSplitButton('Install', 'Installing...', onInstall)
				) : (
					<>
						<button type="button" style={isRunning ? secondaryBtnStyle(hoveredBtn === `${idPrefix}-docker-startstop`, allDisabled) : primaryBtnStyle(hoveredBtn === `${idPrefix}-docker-startstop`, allDisabled)} disabled={allDisabled} onClick={isRunning ? onStop : onStart} onMouseEnter={() => setHoveredBtn(`${idPrefix}-docker-startstop`)} onMouseLeave={() => setHoveredBtn(null)}>
							{status.state === 'starting' ? 'Starting...' : status.state === 'stopping' ? 'Stopping...' : isRunning ? 'Stop' : 'Start'}
						</button>
						<button type="button" style={secondaryBtnStyle(hoveredBtn === `${idPrefix}-docker-remove`, allDisabled)} disabled={allDisabled} onClick={onRemove} onMouseEnter={() => setHoveredBtn(`${idPrefix}-docker-remove`)} onMouseLeave={() => setHoveredBtn(null)}>
							Remove
						</button>
						{renderSplitButton('Update', 'Updating...', onUpdate, true)}
					</>
				)}
			</div>
		</>
	);
};
