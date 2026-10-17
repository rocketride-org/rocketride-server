// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// SOURCE CONTROL — the workspace-changes panel (the rail's SCM view)
// =============================================================================
//
// Git's GESTURES over the staged workspace view — honestly labeled as
// workspace changes, not a git repository. What it is: every saved-but-
// uncommitted change (changedPaths()), per-file diff tabs, per-file discard
// (git checkout -- <path>), Commit all, Discard all. What it deliberately is
// NOT (and must never pretend to be): branches, merge, history, remotes.
//
// Selective (per-file) COMMIT and stashes are v2 — they change the staging
// storage layout and ship under their own reviewed plan.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles, ConfirmDialog, Button, BxFile, BxUndo, BxRefresh } from 'shell';
import { getWorkspace, getStagedWorkspace } from '../workspace/workspace';
import { openWorkspaceFile } from '../workspace/openWorkspaceFile';
import { getDocs } from '../docs';
import type { ChangeKind, StagedConflict } from 'shared/workspace/stagedFileSystem';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
	} as CSSProperties,
	header: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		padding: '8px 12px',
		flexShrink: 0,
	} as CSSProperties,
	headerRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,
	count: {
		...commonStyles.labelUppercase,
		flex: 1,
	} as CSSProperties,
	iconBtn: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '2px 4px',
		borderRadius: 3,
		color: 'var(--rr-text-secondary)',
		display: 'flex',
		alignItems: 'center',
	} as CSSProperties,
	list: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: '2px 6px',
	} as CSSProperties,
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '1px 8px',
		borderRadius: 5,
		lineHeight: '22px',
		cursor: 'pointer',
		userSelect: 'none' as const,
	} as CSSProperties,
	rowName: {
		...commonStyles.textEllipsis,
		minWidth: 0,
	} as CSSProperties,
	rowDir: {
		...commonStyles.textEllipsis,
		minWidth: 0,
		flex: 1,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	letter: (color: string): CSSProperties => ({
		fontSize: 11,
		fontWeight: 600,
		color,
		flexShrink: 0,
		width: 12,
		textAlign: 'center',
	}),
	empty: {
		...commonStyles.textMuted,
		padding: 16,
		fontSize: 12,
		textAlign: 'center' as const,
	} as CSSProperties,
	note: {
		padding: '6px 12px',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	} as CSSProperties,
};

/** The Explorer's decoration palette — the two surfaces must agree. */
const SCM_COLORS: Record<ChangeKind, string> = {
	added: 'var(--rr-scm-added, #81b88b)',
	modified: 'var(--rr-scm-modified, #e2c08d)',
	deleted: 'var(--rr-scm-deleted, #c74e39)',
};

/** Decoration letters, VS Code vocabulary. */
const SCM_LETTERS: Record<ChangeKind, string> = { added: 'A', modified: 'M', deleted: 'D' };

const HOVER_BG = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Source Control panel: pending workspace changes with per-file diff and
 * discard, plus Commit all / Discard all through the CommitPolicy.
 */
const ScmProvider: React.FC = () => {
	// --- Pending changes, refreshed on every view tick -------------------------
	const [changes, setChanges] = useState<Array<{ path: string; kind: ChangeKind }>>([]);
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	// Pane hover gates the header action cluster (the platform-standard
	// pane-header treatment — see commonStyles.paneHeaderActions).
	const [paneHovered, setPaneHovered] = useState(false);
	const [busy, setBusy] = useState(false);

	const snapshot = useCallback(() => {
		const map = getStagedWorkspace().changedPaths();
		setChanges([...map.entries()].map(([path, kind]) => ({ path, kind })).sort((x, y) => x.path.localeCompare(y.path)));
	}, []);

	useEffect(() => {
		snapshot();
		return getStagedWorkspace().subscribe(snapshot);
	}, [snapshot]);

	// --- Dialog state ------------------------------------------------------------
	const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);
	const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel: string } | null>(null);
	const [conflicts, setConflicts] = useState<StagedConflict[] | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	/** Shows a confirm dialog; resolves true/false on the user's answer. */
	const showConfirm = useCallback((title: string, message: string, confirmLabel: string): Promise<boolean> => {
		return new Promise((resolve) => {
			confirmResolveRef.current = resolve;
			setConfirmState({ title, message, confirmLabel });
		});
	}, []);

	/** Dismisses the dialog and resolves the pending promise. */
	const handleConfirmResult = useCallback((confirmed: boolean) => {
		setConfirmState(null);
		const resolve = confirmResolveRef.current;
		confirmResolveRef.current = null;
		if (resolve) queueMicrotask(() => resolve(confirmed));
	}, []);

	// --- Actions -------------------------------------------------------------------

	/** Commit everything; conflicts (base moved underneath) block atomically. */
	const handleCommitAll = useCallback(async () => {
		setBusy(true);
		try {
			const result = await getWorkspace().policy.commitAll();
			if (result.conflicts.length > 0) setConflicts(result.conflicts);
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, []);

	/** Discard everything, after the same confirm the status line uses. */
	const handleDiscardAll = useCallback(async () => {
		const confirmed = await showConfirm(
			'Discard all pending changes',
			`Discard ${changes.length} uncommitted change(s)? Your workspace returns to the last committed state; this cannot be undone.`,
			'Discard all',
		);
		if (!confirmed) return;
		setBusy(true);
		try {
			await getWorkspace().policy.discardAll();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [changes.length, showConfirm]);

	/** Per-file discard — git checkout -- <path>. */
	const handleDiscardPath = useCallback(async (path: string) => {
		const leaf = path.split('/').pop() ?? path;
		const confirmed = await showConfirm('Discard changes', `Discard changes to "${leaf}"? This cannot be undone.`, 'Discard');
		if (!confirmed) return;
		try {
			await getStagedWorkspace().discardPath(path);
			// A diff tab for a discarded path shows stale content — close it.
			getDocs()?.discardDocument(`diff:${path}`);
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}, [showConfirm]);

	/** A change row opens its diff tab. */
	const handleOpenDiff = useCallback((path: string) => {
		const leaf = path.split('/').pop() ?? path;
		getDocs()?.openStaticDocument(`diff:${path}`, `${leaf} (Changes)`);
	}, []);

	// --- Render ----------------------------------------------------------------------
	return (
		<div style={S.container} onMouseEnter={() => setPaneHovered(true)} onMouseLeave={() => setPaneHovered(false)}>
			{/* ── Header: count + bulk verbs ───────────────────────────── */}
			<div style={S.header}>
				<div style={S.headerRow}>
					<span style={S.count}>{changes.length === 0 ? 'No changes' : `${changes.length} pending change${changes.length === 1 ? '' : 's'}`}</span>
					<div style={commonStyles.paneHeaderActions(paneHovered)}>
						<button style={commonStyles.paneHeaderButton} title="Refresh" onClick={snapshot}>
							<BxRefresh size={18} />
						</button>
					</div>
				</div>
				{changes.length > 0 && (
					<div style={S.headerRow}>
						<Button small onClick={() => void handleCommitAll()} disabled={busy}>
							Commit All
						</Button>
						<Button small variant="secondary" onClick={() => void handleDiscardAll()} disabled={busy}>
							Discard All
						</Button>
					</div>
				)}
			</div>

			{/* ── Changes list ─────────────────────────────────────────── */}
			<div style={S.list}>
				{changes.length === 0 && <div style={S.empty}>Nothing to commit — the workspace matches the server.</div>}
				{changes.map(({ path, kind }) => {
					const leaf = path.split('/').pop() ?? path;
					const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
					const hovered = hoveredRow === path;
					return (
						<div
							key={path}
							style={{ ...S.row, ...(hovered ? { background: HOVER_BG } : {}) }}
							onMouseEnter={() => setHoveredRow(path)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => handleOpenDiff(path)}
							title={`${path} — click for diff`}
						>
							<span style={{ ...S.rowName, color: SCM_COLORS[kind] }}>{leaf}</span>
							<span style={S.rowDir}>{dir}</span>
							{hovered && kind !== 'deleted' && (
								<button
									style={S.iconBtn}
									title="Open file"
									onClick={(e) => {
										e.stopPropagation();
										void openWorkspaceFile(path);
									}}
								>
									<BxFile size={14} />
								</button>
							)}
							{hovered && (
								<button
									style={S.iconBtn}
									title="Discard changes"
									onClick={(e) => {
										e.stopPropagation();
										void handleDiscardPath(path);
									}}
								>
									<BxUndo size={14} />
								</button>
							)}
							<span style={S.letter(SCM_COLORS[kind])}>{SCM_LETTERS[kind]}</span>
						</div>
					);
				})}
			</div>

			{/* ── The honesty line: gestures of git, not a repository ──── */}
			<div style={S.note}>Workspace changes — committed to your RocketRide workspace, not a git repository.</div>

			{/* ── Dialogs ──────────────────────────────────────────────── */}
			{confirmState && (
				<ConfirmDialog
					title={confirmState.title}
					message={confirmState.message}
					confirmLabel={confirmState.confirmLabel}
					cancelLabel="Cancel"
					destructive
					onConfirm={() => handleConfirmResult(true)}
					onCancel={() => handleConfirmResult(false)}
				/>
			)}
			{conflicts && (
				<ConfirmDialog
					title="Commit blocked"
					message={`The server changed underneath ${conflicts.length} path(s) — nothing was committed:\n\n${conflicts.map((c) => `${c.path} (${c.reason})`).join('\n')}\n\nRefresh, review the diffs, then commit again.`}
					confirmLabel="OK"
					onConfirm={() => setConflicts(null)}
					onCancel={() => setConflicts(null)}
				/>
			)}
			{actionError && (
				<ConfirmDialog
					title="Source control error"
					message={actionError}
					confirmLabel="OK"
					onConfirm={() => setActionError(null)}
					onCancel={() => setActionError(null)}
				/>
			)}
		</div>
	);
};

export default ScmProvider;
