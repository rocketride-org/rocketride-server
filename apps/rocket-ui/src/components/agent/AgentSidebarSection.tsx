// Copyright (c) 2026 Aparavi Software AG. MIT License.
import React, { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles, BxPlus, BxDotsHorizontal, BxCog } from 'shell';
import { getDocs } from '../../docs';
import { agentApi } from '../../services/agentApi';
import { useSessionList } from '../../hooks/useSessionList';
import type { AgentSessionRecord, SessionStatus } from '../../services/agentTypes';
import { AgentSettings } from './AgentSettings';

// =============================================================================
// STYLES — mirrors SidebarView's Ad-hoc section (SidebarView.tsx ~L276-309)
// =============================================================================

const HOVER_BG = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';

const S = {
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '1px 8px',
		borderRadius: 5,
		fontSize: 13,
		lineHeight: '22px',
		cursor: 'pointer',
		userSelect: 'none' as const,
		position: 'relative' as const,
	} as CSSProperties,
	rowName: {
		...commonStyles.textEllipsis,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	menuBtn: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '2px 4px',
		borderRadius: 3,
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
	} as CSSProperties,
	menu: {
		position: 'absolute' as const,
		right: 6,
		top: '100%',
		zIndex: 10,
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-bg-surface-alt)',
		borderRadius: 6,
		boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
		minWidth: 100,
		padding: 4,
	} as CSSProperties,
	menuItem: {
		display: 'block',
		width: '100%',
		textAlign: 'left' as const,
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '4px 8px',
		fontSize: 12,
		borderRadius: 4,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
};

/** Status dot color per session lifecycle state — green/amber/red/grey. */
function statusDotStyle(status: SessionStatus): CSSProperties {
	switch (status) {
		case 'active':
			return commonStyles.indicatorSuccess;
		case 'paused_auth':
			return commonStyles.indicatorWarning;
		case 'workspace_full':
			return commonStyles.indicatorError;
		case 'archived':
			return commonStyles.indicatorMuted;
		default:
			// Unknown/future server status — neutral grey rather than an
			// invisible dot (the switch was previously non-exhaustive here).
			return commonStyles.indicatorMuted;
	}
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Formats a `lastActivity` epoch-ms timestamp as a short relative string. */
function relativeTime(epochMs: number): string {
	const diffSec = Math.round((epochMs - Date.now()) / 1000);
	if (Math.abs(diffSec) < 60) return rtf.format(diffSec, 'second');
	const diffMin = Math.round(diffSec / 60);
	if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
	const diffHour = Math.round(diffMin / 60);
	if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
	const diffDay = Math.round(diffHour / 24);
	return rtf.format(diffDay, 'day');
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Agent sidebar mode's body: a flat panel listing the caller's Rocket Agent
 * sessions, laid out like the Pipelines panel — a "New session" action at the top,
 * then one row per session (status dot, relative time, overflow menu). Rendered by
 * SidebarProvider as `agentSlot`, which SidebarView surfaces as the "Agent" mode tab
 * — only when `agent.enabled` is on (see P4-V5 in the task brief), so this component
 * itself never needs to gate its own network calls.
 */
export function AgentSidebarSection(): React.JSX.Element {
	const { sessions, refresh } = useSessionList();
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);

	// pipesTouched/status can change after a save-back (D2) elsewhere in the app.
	useEffect(() => {
		const handler = () => refresh();
		window.addEventListener('project:saved', handler);
		return () => window.removeEventListener('project:saved', handler);
	}, [refresh]);

	const handleNewSession = useCallback(() => {
		void agentApi.create({}).then((r) => {
			refresh();
			getDocs()?.openStaticDocument(`agent:${r.sessionId}`, r.title || 'Agent session');
		});
	}, [refresh]);

	const handleOpen = useCallback((s: AgentSessionRecord) => {
		// Tab label is fixed at open time from the list snapshot — a rename
		// afterwards needs a reopen to relabel the tab (noted in the PR).
		getDocs()?.openStaticDocument(`agent:${s.sessionId}`, s.title || 'Agent session');
	}, []);

	const handleRename = useCallback(
		(s: AgentSessionRecord) => {
			setOpenMenuFor(null);
			const next = window.prompt('Rename session', s.title);
			if (!next || next === s.title) return;
			void agentApi.rename(s.sessionId, next).then(refresh);
		},
		[refresh]
	);

	const handleArchive = useCallback(
		(s: AgentSessionRecord) => {
			setOpenMenuFor(null);
			void agentApi.archive(s.sessionId).then(refresh);
		},
		[refresh]
	);

	const handleDelete = useCallback(
		(s: AgentSessionRecord) => {
			setOpenMenuFor(null);
			// Hard delete is irreversible (unlike Archive, which stays resumable) — confirm first.
			if (!window.confirm(`Delete "${s.title || 'Agent session'}"? This permanently removes its transcript and workspace.`)) return;
			void agentApi.remove(s.sessionId).then(refresh);
		},
		[refresh]
	);

	return (
		<div style={{ padding: '2px 6px' }}>
			{/* "New session" — the panel's top action, mirroring the Pipelines panel's "+ New pipeline". */}
			{/* Settings entry sits at the top of the panel's action rows — above New session —
			    rather than buried in the chat header's top-right, so it's the first thing seen. */}
			<div
				style={{ ...S.row, ...(hoveredRow === 'agent-settings' ? { background: HOVER_BG } : {}) }}
				onMouseEnter={() => setHoveredRow('agent-settings')}
				onMouseLeave={() => setHoveredRow(null)}
				onClick={() => setSettingsOpen(true)}
			>
				<BxCog size={14} />
				<span style={S.rowName}>Agent inference settings</span>
			</div>
			<div style={{ ...S.row, ...(hoveredRow === 'agent-new' ? { background: HOVER_BG } : {}) }} onMouseEnter={() => setHoveredRow('agent-new')} onMouseLeave={() => setHoveredRow(null)} onClick={handleNewSession}>
				<BxPlus size={14} />
				<span style={S.rowName}>New session</span>
			</div>
			{sessions.length === 0 && (
				<div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--rr-text-secondary)' }}>No sessions yet — start one with New session.</div>
			)}
			{sessions.map((sess) => {
				const rowKey = `agent:${sess.sessionId}`;
				return (
					<div
						key={rowKey}
						style={{ ...S.row, ...(hoveredRow === rowKey ? { background: HOVER_BG } : {}) }}
						onMouseEnter={() => setHoveredRow(rowKey)}
						onMouseLeave={() => setHoveredRow(null)}
						onClick={() => handleOpen(sess)}
						{...(sess.pipesTouched.length > 0 ? { title: sess.pipesTouched.join(', ') } : {})}
					>
						<div style={statusDotStyle(sess.status)} />
						<span style={S.rowName}>{sess.title || 'Agent session'}</span>
						<span style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginLeft: 4, flexShrink: 0 }}>{relativeTime(sess.lastActivity)}</span>
						{hoveredRow === rowKey && (
							<button
								style={S.menuBtn}
								title="More"
								onClick={(e) => {
									e.stopPropagation();
									setOpenMenuFor((p) => (p === rowKey ? null : rowKey));
								}}
							>
								<BxDotsHorizontal size={14} />
							</button>
						)}
						{openMenuFor === rowKey && (
							<div style={S.menu} onClick={(e) => e.stopPropagation()}>
								<button style={S.menuItem} onClick={() => handleRename(sess)}>
									Rename
								</button>
								<button style={S.menuItem} onClick={() => handleArchive(sess)}>
									Archive
								</button>
								<button style={{ ...S.menuItem, color: 'var(--rr-color-error)' }} onClick={() => handleDelete(sess)}>
									Delete
								</button>
							</div>
						)}
					</div>
				);
			})}
			{settingsOpen && <AgentSettings onClose={() => setSettingsOpen(false)} />}
		</div>
	);
}
