// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ServicePanel — target panel for Service (OS daemon) connection mode.
 *
 * Shows service status, version, install path, and action buttons
 * (Install/Start/Stop/Remove/Update with version dropdown).
 * Includes sudo password prompt for Linux/macOS.
 *
 * Used by ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React, { useState, useEffect } from 'react';
import ServiceIcon from '../../../../assets/service.svg';
import { ServiceStatus, VersionOption, displayVersion, stateLabels, panelStyles as S, statusIndicatorStyle, primaryBtnStyle, secondaryBtnStyle, optionStyle } from './shared';
import { MessageData } from '../../Settings/SettingsWebview';
import { MessageDisplay } from '../../Settings/MessageDisplay';

// =============================================================================
// TYPES
// =============================================================================

export interface ServicePanelProps {
	/** Unique prefix for HTML element IDs (e.g. 'dev', 'deploy', 'welcome'). */
	idPrefix: string;
	/** Current service daemon state from OS-level polling. */
	status: ServiceStatus;
	/** Streamed progress text during install/update/remove (null when idle). */
	progress: string | null;
	/** Error message from the last failed action (null on success). */
	error: string | null;
	/** True while an ioControl action is in flight. */
	busy: boolean;
	/** Which action is currently running (drives button label text). */
	action: 'install' | 'update' | 'remove' | 'start' | 'stop' | null;
	/** Available versions for the split-button dropdown. */
	versions: VersionOption[];
	selectedVersion: string;
	onVersionChange: (version: string) => void;
	onInstall: () => void;
	onUpdate: () => void;
	onRemove: () => void;
	onStart: () => void;
	onStop: () => void;
	/** Whether the sudo password overlay is visible (Linux/macOS only). */
	sudoPromptVisible: boolean;
	sudoPasswordInput: string;
	onSudoPasswordChange: (password: string) => void;
	onSudoSubmit: () => void;
	/** Test connection callback — only enabled when service is running. */
	onTestConnection?: () => void;
	/** Inline test result (success/error) shown below the test button. */
	testMessage?: MessageData | null;
	/** When true, hides advanced fields (used on Welcome page). */
	simplified?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const ServicePanel: React.FC<ServicePanelProps> = ({ idPrefix, status, progress, error, busy, action, versions, selectedVersion, onVersionChange, onInstall, onUpdate, onRemove, onStart, onStop, sudoPromptVisible, sudoPasswordInput, onSudoPasswordChange, onSudoSubmit, onTestConnection, testMessage }) => {
	const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
	const [hoveredOption, setHoveredOption] = useState<string | null>(null);
	const [dropdownOpen, setDropdownOpen] = useState(false);

	// Close dropdown on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target.closest(`[data-split-button="${idPrefix}-service"]`)) {
				setDropdownOpen(false);
			}
		};
		document.addEventListener('click', handler);
		return () => document.removeEventListener('click', handler);
	}, [idPrefix]);

	const transitional = status.state === 'starting' || status.state === 'stopping';
	const allDisabled = busy || transitional || sudoPromptVisible;
	const isRunning = status.state === 'running' || status.state === 'stopping';
	const showInstall = status.state === 'not-installed' && !(busy && action === 'remove');

	// =========================================================================
	// SPLIT BUTTON
	// =========================================================================

	const renderSplitButton = (label: string, busyLabel: string, onClick: () => void, primary: boolean = true) => {
		const currentLabel = versions.find((v) => v.value === selectedVersion)?.label ?? '<Latest>';
		const btnStyle = primary ? primaryBtnStyle : secondaryBtnStyle;
		const mainId = `${idPrefix}-service-main`;
		const arrowId = `${idPrefix}-service-arrow`;

		return (
			<div style={S.splitButton} data-split-button={`${idPrefix}-service`}>
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
						<div style={S.splitDropdownGroupLabel}>Recommended</div>
						{versions.filter((v) => v.value === 'latest' || v.value === 'prerelease').map((opt) => {
							const optKey = `${idPrefix}-service-${opt.value}`;
							return (
								<button type="button" key={opt.value} role="menuitem" style={optionStyle(opt.value === selectedVersion, hoveredOption === optKey)} onClick={() => { onVersionChange(opt.value); setDropdownOpen(false); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { onVersionChange(opt.value); setDropdownOpen(false); } if (e.key === 'Escape') setDropdownOpen(false); }} onMouseEnter={() => setHoveredOption(optKey)} onMouseLeave={() => setHoveredOption(null)}>
									{opt.label}
								</button>
							);
						})}
						{versions.some((v) => v.value !== 'latest' && v.value !== 'prerelease') && (
							<>
								<div style={S.splitDropdownGroupLabel}>All versions</div>
								{versions.filter((v) => v.value !== 'latest' && v.value !== 'prerelease').map((opt) => {
									const optKey = `${idPrefix}-service-${opt.value}`;
									return (
										<button type="button" key={opt.value} role="menuitem" style={optionStyle(opt.value === selectedVersion, hoveredOption === optKey)} onClick={() => { onVersionChange(opt.value); setDropdownOpen(false); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { onVersionChange(opt.value); setDropdownOpen(false); } if (e.key === 'Escape') setDropdownOpen(false); }} onMouseEnter={() => setHoveredOption(optKey)} onMouseLeave={() => setHoveredOption(null)}>
											{opt.label}
										</button>
									);
								})}
							</>
						)}
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
				<ServiceIcon role="img" aria-label="Service" style={{ width: 48, height: 48, flexShrink: 0 }} />
				<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>Install as a system service on this machine. The service runs independently and starts automatically on boot.</div>
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
					{status.installPath && (
						<div style={S.statusRow}>
							<span style={{ color: 'var(--rr-text-secondary)', minWidth: 65 }}>Location:</span>
							<span style={{ fontFamily: 'var(--vscode-editor-font-family)', fontSize: 12, opacity: 0.8 }}>{status.installPath}</span>
						</div>
					)}
				</div>
			)}

			{/* Sudo prompt / Progress / Error */}
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
							onChange={(e) => onSudoPasswordChange(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && sudoPasswordInput) onSudoSubmit();
							}}
							autoFocus
						/>
						<button type="button" style={primaryBtnStyle(hoveredBtn === `${idPrefix}-sudo-continue`, !sudoPasswordInput)} onClick={onSudoSubmit} disabled={!sudoPasswordInput} onMouseEnter={() => setHoveredBtn(`${idPrefix}-sudo-continue`)} onMouseLeave={() => setHoveredBtn(null)}>
							Continue
						</button>
					</div>
				</div>
			) : (
				<>
					{progress && <div style={S.progress}>{progress}</div>}
					{error && <div style={S.error}>{error}</div>}
				</>
			)}

			{/* Actions */}
			<div style={S.actions}>
				{showInstall ? (
					renderSplitButton('Install', 'Installing...', onInstall)
				) : (
					<>
						<button type="button" style={isRunning ? secondaryBtnStyle(hoveredBtn === `${idPrefix}-service-startstop`, allDisabled) : primaryBtnStyle(hoveredBtn === `${idPrefix}-service-startstop`, allDisabled)} disabled={allDisabled} onClick={isRunning ? onStop : onStart} onMouseEnter={() => setHoveredBtn(`${idPrefix}-service-startstop`)} onMouseLeave={() => setHoveredBtn(null)}>
							{status.state === 'starting' ? 'Starting...' : status.state === 'stopping' ? 'Stopping...' : isRunning ? 'Stop' : 'Start'}
						</button>
						<button type="button" style={secondaryBtnStyle(hoveredBtn === `${idPrefix}-service-remove`, allDisabled)} disabled={allDisabled} onClick={onRemove} onMouseEnter={() => setHoveredBtn(`${idPrefix}-service-remove`)} onMouseLeave={() => setHoveredBtn(null)}>
							Remove
						</button>
						{renderSplitButton('Update', 'Updating...', onUpdate, true)}
					</>
				)}
			</div>

			{/* Test connection — visible when installed, enabled only when running */}
			{onTestConnection && status.state !== 'not-installed' && (
				<div style={{ marginTop: 12 }}>
					<button
						type="button"
						onClick={onTestConnection}
						disabled={status.state !== 'running' || busy}
						style={secondaryBtnStyle(hoveredBtn === `${idPrefix}-service-test`, status.state !== 'running' || busy)}
						onMouseEnter={() => setHoveredBtn(`${idPrefix}-service-test`)}
						onMouseLeave={() => setHoveredBtn(null)}
					>
						Test Connection
					</button>
				</div>
			)}
			{testMessage && <MessageDisplay message={testMessage} inline />}
		</>
	);
};
