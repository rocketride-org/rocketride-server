// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeploymentRecordPanel — the deployment record drawer.
 *
 * The record-panel form of one team deployment (sibling precedent:
 * ConnectionRecordPanel / TaskRecordPanel): a WIDE viewport DetailPanel —
 * defaulting to ~75% of the host surface, drag-resizable and persisted —
 * hosting the full {@link DeploymentView} (STATUS | RUNS | DESIGN strip)
 * as a flush body. Replaces the per-deployment document tab: a deployment
 * is the record behind a where-live row / version badge, so clicking one
 * opens the record panel (house rule), and the DVR/history content
 * reconstructs from the server-persisted run-log continuum on every open.
 *
 * Record-panel standard: EVERY record verb lives in the DRAWER FOOTER —
 * Remove (destructive) left-anchored, Pause/Resume · Rollback · Deploy
 * version… right-aligned, each ConfirmDialog-guarded. Without task.control
 * the panel is pure inspect: NO footer. The drawer's EntityHeader names the
 * deployment, so the hosted view gets no `documentTitle` (no double title).
 */

import React, { useEffect, useMemo, useRef, useState, CSSProperties } from 'react';

import { Button } from '../button/Button';
import { Modal } from '../modal/Modal';
import { ConfirmDialog } from '../modal/ConfirmDialog';
import { DetailPanel } from '../detail-panel/DetailPanel';
import { commonStyles } from '../../themes/styles';
import { formatTime } from '../../modules/server/util/formatters';
import { DeploymentView } from './DeploymentView';
import type { IDeploymentViewProps } from './DeploymentView';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default drawer width as a fraction of the host surface (clamped by the
    DetailPanel's own band: never wider than 85% minus the context sliver). */
const DEFAULT_HOST_FRACTION = 0.75;

// =============================================================================
// STYLES
// =============================================================================

const S = {
	stateMessage: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		color: 'var(--rr-text-secondary)',
		fontSize: 13.5,
	} as CSSProperties,
	/** Left-anchored verb group in the panel footer (footer is flex-end). */
	footerVerbs: {
		marginRight: 'auto',
		display: 'flex',
		gap: 8,
	} as CSSProperties,
	footerError: {
		color: 'var(--rr-color-error)',
		fontSize: 12.5,
		alignSelf: 'center',
	} as CSSProperties,
	pickerRow: (enabled: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '9px 12px',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		marginBottom: 8,
		cursor: enabled ? 'pointer' : 'default',
		opacity: enabled ? 1 : 0.55,
	}),
};

// =============================================================================
// PROPS
// =============================================================================

/** The loaded record: the DeploymentView prop set (minus the page title the
    drawer header replaces) plus the record verbs the footer runs. */
export interface IDeploymentRecordData extends Omit<IDeploymentViewProps, 'documentTitle'> {
	/** The focused source's schedule paused flag; undefined = no schedule
	    (the Pause/Resume verb renders only when a schedule exists). */
	sourcePaused?: boolean;
	/** The focused source's SERVER-TRUTH execution settings. */
	sourceConfig?: { traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null; debugOut: boolean };
	/** Persist staged execution settings (the Save verb). */
	onSetSourceConfig?: (traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null, debugOut: boolean) => Promise<void>;
	/** Pause/resume the focused source's schedule, preserving cron/ttl. */
	onSetSchedulePaused?: (paused: boolean) => Promise<void>;
	/** Start the FOCUSED source now (footer verb; the smoke-test path). */
	onRunSource?: (sourceId: string) => Promise<void>;
	/** Stop the focused source's live run (footer verb, confirm-guarded). */
	onStopSource?: (sourceId: string) => Promise<void>;
}

/** Props for {@link DeploymentRecordPanel}. ONE drawer instance covers the
    whole lifecycle: `data` absent renders the loading/error body in the SAME
    panel — never a second mount, so the slide-in and the width happen once. */
export interface IDeploymentRecordPanelProps {
	/** Whether the drawer is open (renders nothing when closed). */
	open: boolean;
	/** Dismiss the drawer (close glyph / Escape / sliver). */
	onClose: () => void;
	/** Drawer title until the record names itself (e.g. 'Staging / proj'). */
	fallbackTitle: string;
	/** Load failure message (rendered as the body while data is absent). */
	loadError?: string;
	/** The loaded record; absent = loading (or failed, when loadError set). */
	data?: IDeploymentRecordData;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders one team deployment as a wide record drawer with its verbs in the
 * footer (the record-panel standard).
 *
 * @param props - {@link IDeploymentRecordPanelProps}.
 * @returns The drawer element, or null while closed.
 */
export const DeploymentRecordPanel: React.FC<IDeploymentRecordPanelProps> = ({ open, onClose, fallbackTitle, loadError, data }) => {
	// Default width per MOUNT: 75% of the viewport at first render (the
	// DetailPanel clamps to its usable band and a persisted drag width
	// overrides, so a later host resize only moves the clamp).
	const width = useMemo(() => Math.round(window.innerWidth * DEFAULT_HOST_FRACTION), []);

	// --- Verb flow state (dialog-guarded; the record panel owns its verbs) ---

	// A staged stop of the focused source awaiting confirmation.
	const [stopOpen, setStopOpen] = useState(false);
	// Staged Execution-card edits; null = pristine (mirror the server). The
	// guideline form: Save/Cancel MATERIALIZE in the footer on the first
	// change — their presence IS the dirty indicator.
	const [stagedConfig, setStagedConfig] = useState<{ traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null; debugOut: boolean } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	// Identity of the focused record. ONE drawer instance persists across
	// selections (sibling precedent), so the verb state above is cleared
	// whenever the focused record changes — a staged edit, an open confirm
	// dialog, or an error from the PREVIOUS record must never arm a verb
	// against the NEXT one.
	const recordKey = data ? `${data.teamName}:${data.deployment.pipelineName}:${data.sourceId}` : null;
	const prevRecordKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (recordKey !== null && recordKey !== prevRecordKeyRef.current) {
			prevRecordKeyRef.current = recordKey;
			setStagedConfig(null);
			setStopOpen(false);
			setError('');
		}
	}, [recordKey]);

	/** Run one verb with shared busy/error handling (dialogs close first). */
	const run = async (action: () => Promise<void>): Promise<void> => {
		setBusy(true);
		setError('');
		try {
			await action();
			setStopOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (!open) return null;

	// Not loaded yet: the SAME drawer shell with the state message — the
	// opening gesture is never a dead click and never a double slide-in.
	if (!data) {
		return (
			<DetailPanel open onClose={onClose} title={fallbackTitle} subtitle="Team deployment — scheduled runs, monitoring, and replay" width={width} persistKey="panelDeploymentRecordWidth" flushBody>
				<div style={S.stateMessage}>{loadError ? `Failed to load deployment: ${loadError}` : 'Loading deployment\u2026'}</div>
			</DetailPanel>
		);
	}

	const { sourcePaused, onSetSchedulePaused, sourceConfig, onSetSourceConfig, onRunSource, onStopSource, ...viewProps } = data;
	const sourceRunning = Boolean(viewProps.runningSources?.[viewProps.sourceId]);
	// Effective Execution settings = staged edits over server truth; dirty
	// only when they actually differ (re-selecting the same values is a
	// no-op, so Save/Cancel stay hidden).
	const serverConfig = sourceConfig ?? { traceLevel: null, debugOut: false };
	const effectiveConfig = stagedConfig ?? serverConfig;
	const configDirty = stagedConfig !== null && (stagedConfig.traceLevel !== serverConfig.traceLevel || stagedConfig.debugOut !== serverConfig.debugOut);
	const { teamName, deployment } = viewProps;

	// Pure inspect without task.control: NO footer (the guideline). The
	// verbs are the SOURCE-schedule pair — [Pause|Resume][Run|Stop], the
	// SchedulePanel's own verbs — LEFT-anchored; errors surface to their
	// right. Run/Stop are the dev-run pair (danger red, one slot: Run flips
	// to Stop while the source is live). Deployment-level verbs
	// (enable/disable, remove, pointer moves) live on the DEPLOY page.
	const footer = viewProps.canControl ? (
		<>
			<span style={S.footerVerbs}>
				{onSetSchedulePaused && sourcePaused !== undefined && (
					<Button variant="secondary" small disabled={busy} onClick={() => void run(() => onSetSchedulePaused(!sourcePaused))}>
						{sourcePaused ? 'Resume' : 'Pause'}
					</Button>
				)}
				{onRunSource && !sourceRunning && deployment.state === 'enabled' && (
					<Button variant="danger" small disabled={busy} onClick={() => void run(() => onRunSource(viewProps.sourceId))}>
						Run
					</Button>
				)}
				{onStopSource && sourceRunning && (
					<Button variant="danger" small disabled={busy} onClick={() => setStopOpen(true)}>
						Stop
					</Button>
				)}
			</span>
			{error && <span style={S.footerError}>{error}</span>}
			{configDirty && stagedConfig && onSetSourceConfig && (
				<>
					<Button
						variant="primary"
						small
						disabled={busy}
						onClick={() =>
							void run(async () => {
								await onSetSourceConfig(stagedConfig.traceLevel, stagedConfig.debugOut);
								setStagedConfig(null);
							})
						}
					>
						{busy ? 'Saving…' : 'Save'}
					</Button>
					<Button variant="ghost" small disabled={busy} onClick={() => setStagedConfig(null)}>
						Cancel
					</Button>
				</>
			)}
		</>
	) : undefined;

	return (
		<>
			<DetailPanel open={open} onClose={onClose} title={`${teamName} / ${deployment.pipelineName} / ${viewProps.sourceName || viewProps.sourceId}`} subtitle="Team deployment — scheduled runs, monitoring, and replay" width={width} persistKey="panelDeploymentRecordWidth" flushBody busy={busy} {...(footer ? { footer } : {})}>
				{/* The view renders its own TabControl strip + panels; the drawer
				    header carries the title, so no documentTitle (no doubling). */}
				<DeploymentView {...viewProps} {...(sourceConfig && onSetSourceConfig ? { sourceConfig: effectiveConfig, onSourceConfigChange: setStagedConfig } : {})} />
			</DetailPanel>

			{/* ── Stop-run confirmation ───────────────────────────────────── */}
			{stopOpen && onStopSource && <ConfirmDialog title={`Stop ${viewProps.sourceName || viewProps.sourceId}?`} message="Terminates the live run of this source. Everything logged so far stays in the team continuum." confirmLabel="Stop run" cancelLabel="Cancel" onConfirm={() => void run(() => onStopSource(viewProps.sourceId))} onCancel={() => setStopOpen(false)} />}
		</>
	);
};
