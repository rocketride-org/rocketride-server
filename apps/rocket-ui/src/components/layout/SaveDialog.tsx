import React, { useState, useRef, useEffect, useCallback, CSSProperties } from 'react';
import { commonStyles } from 'shell';
import type { RocketRideClient } from 'shell';
import { usePipelineTree } from '../../hooks/usePipelineTree';
import type { TreeNode } from '../../hooks/usePipelineTree';
import { BxChevronRight, BxFolderOpen } from 'shell';

// =============================================================================
// TYPES
// =============================================================================

interface SaveDialogProps {
	client: RocketRideClient | null;
	isConnected: boolean;
	onConfirm: (path: string) => void;
	onCancel: () => void;
}

// =============================================================================
// HELPERS
// =============================================================================

const FILENAME_REGEX = /^[a-zA-Z0-9 _\-]+$/;

function getDirNodes(nodes: TreeNode[]): TreeNode[] {
	return nodes.filter((n) => n.type === 'dir');
}

// =============================================================================
// DIR PICKER — shows only folders, recursive
// =============================================================================

interface DirPickerProps {
	nodes: TreeNode[];
	depth: number;
	selectedDir: string;
	expandedDirs: Set<string>;
	onSelect: (path: string) => void;
	onToggle: (path: string) => void;
}

const DirPicker: React.FC<DirPickerProps> = ({ nodes, depth, selectedDir, expandedDirs, onSelect, onToggle }) => {
	const dirs = getDirNodes(nodes);
	const indent = 8 + depth * 16;

	return (
		<>
			{dirs.map((node) => {
				const isExpanded = expandedDirs.has(node.path);
				const isSelected = selectedDir === node.path;
				const hasDirs = getDirNodes(node.type === 'dir' ? node.children : []).length > 0;
				return (
					<React.Fragment key={node.path}>
						<div
							style={{
								display: 'flex', alignItems: 'center', gap: 4,
								paddingLeft: indent, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
								borderRadius: 5, cursor: 'pointer', fontSize: 13, userSelect: 'none',
								background: isSelected ? 'var(--rr-bg-list-active)' : 'transparent',
								color: isSelected ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
							}}
							onClick={() => { onSelect(node.path); if (hasDirs) onToggle(node.path); }}
						>
							<span style={{ display: 'inline-flex', alignItems: 'center', width: 14, height: 14, flexShrink: 0, opacity: hasDirs ? 1 : 0 }}>
								<BxChevronRight size={12} style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 100ms ease' }} />
							</span>
							<span style={{ display: 'inline-flex', alignItems: 'center', width: 16, height: 16, flexShrink: 0, color: isSelected ? 'inherit' : 'var(--rr-text-secondary)' }}>
								<BxFolderOpen size={14} />
							</span>
							<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
						</div>
						{isExpanded && (
							<DirPicker nodes={node.type === 'dir' ? node.children : []} depth={depth + 1} selectedDir={selectedDir} expandedDirs={expandedDirs} onSelect={onSelect} onToggle={onToggle} />
						)}
					</React.Fragment>
				);
			})}
		</>
	);
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	dialog: {
		...commonStyles.dialog,
		// Anchors the absolutely-positioned dialogClose button below.
		position: 'relative',
		width: 540,
		display: 'flex', flexDirection: 'column',
		overflow: 'hidden',
	} as CSSProperties,
	// Close floats over the dialog's top-right corner (same pattern as the
	// shell OverlayManager styles.dialogClose). Acts as Cancel.
	dialogClose: {
		...commonStyles.buttonSecondary,
		position: 'absolute',
		top: 12,
		right: 12,
		zIndex: 10,
		fontFamily: 'var(--rr-font-family)',
		lineHeight: 1,
		padding: '4px 10px',
	} as CSSProperties,
	header: {
		padding: '16px 20px 12px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 15, fontWeight: 600, color: 'var(--rr-text-primary)',
	} as CSSProperties,
	locationBar: {
		display: 'flex', alignItems: 'center', gap: 6,
		padding: '8px 16px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 12, color: 'var(--rr-text-secondary)',
		background: 'var(--rr-bg-default)',
	} as CSSProperties,
	treeArea: {
		flex: 1, overflowY: 'auto',
		padding: '6px 8px',
		minHeight: 200, maxHeight: 280,
		background: 'var(--rr-bg-default)',
	} as CSSProperties,
	rootRow: (isSelected: boolean): CSSProperties => ({
		display: 'flex', alignItems: 'center', gap: 6,
		padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
		fontSize: 13, userSelect: 'none',
		background: isSelected ? 'var(--rr-bg-list-active)' : 'transparent',
		color: isSelected ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
	}),
	footer: {
		padding: '12px 20px',
		borderTop: '1px solid var(--rr-border)',
		display: 'flex', flexDirection: 'column', gap: 10,
	} as CSSProperties,
	filenameRow: {
		display: 'flex', alignItems: 'center', gap: 10,
	} as CSSProperties,
	label: {
		fontSize: 13, color: 'var(--rr-text-secondary)', minWidth: 72, textAlign: 'right',
	} as CSSProperties,
	input: {
		...commonStyles.inputField,
		flex: 1,
	} as CSSProperties,
	buttonRow: {
		display: 'flex', justifyContent: 'flex-end', gap: 8,
	} as CSSProperties,
	cancelBtn: commonStyles.buttonSecondary,
	saveBtn: (enabled: boolean): CSSProperties => ({
		...commonStyles.buttonPrimary,
		fontWeight: 600,
		...(enabled ? {} : commonStyles.buttonDisabled),
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

const SaveDialog: React.FC<SaveDialogProps> = ({ client, isConnected, onConfirm, onCancel }) => {
	const [name, setName] = useState('');
	const [selectedDir, setSelectedDir] = useState('');
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
	const inputRef = useRef<HTMLInputElement>(null);

	const { tree } = usePipelineTree(client, isConnected);

	useEffect(() => { inputRef.current?.focus(); }, []);

	const trimmed = name.trim();
	const valid = trimmed.length > 0 && FILENAME_REGEX.test(trimmed);

	const handleConfirm = useCallback(() => {
		if (!valid) return;
		const path = selectedDir ? `${selectedDir}/${trimmed}.pipe` : `${trimmed}.pipe`;
		onConfirm(path);
	}, [valid, selectedDir, trimmed, onConfirm]);

	/**
	 * Dismisses the dialog on Escape from anywhere inside it. Attached to the
	 * dialog container so the keydown bubbles up from whichever child holds
	 * focus (input, buttons, tree rows) — no document listener needed.
	 */
	const handleDialogKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === 'Escape') onCancel();
	}, [onCancel]);

	const toggleDir = useCallback((path: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path); else next.add(path);
			return next;
		});
	}, []);

	const locationLabel = selectedDir
		? `Pipeline root / ${selectedDir.split('/').join(' / ')}`
		: 'Pipeline root';

	return (
		/* Backdrop is inert: dismissal is deliberate-only (✕ / Cancel / Escape)
		   per the 2026-07-08 design decision — clicking outside must NOT close. */
		<div style={commonStyles.modalOverlay}>
			<div style={styles.dialog} onKeyDown={handleDialogKeyDown}>
				{/* Top-right close button — same action as Cancel. */}
				<button style={styles.dialogClose} onClick={onCancel} aria-label="Close">✕</button>

				<div style={styles.header}>Save Pipeline As</div>

				<div style={styles.locationBar}>
					<span>Save in:</span>
					<span style={{ color: 'var(--rr-text-primary)', fontWeight: 500 }}>{locationLabel}</span>
				</div>

				<div style={styles.treeArea}>
					{/* Root option */}
					<div style={styles.rootRow(selectedDir === '')} onClick={() => setSelectedDir('')}>
						<BxFolderOpen size={14} style={{ color: 'inherit', flexShrink: 0 }} />
						<span>Pipeline root</span>
					</div>

					{/* Subdirectory tree */}
					<DirPicker
						nodes={tree}
						depth={1}
						selectedDir={selectedDir}
						expandedDirs={expandedDirs}
						onSelect={setSelectedDir}
						onToggle={toggleDir}
					/>
				</div>

				<div style={styles.footer}>
					<div style={styles.filenameRow}>
						<span style={styles.label}>Name:</span>
						<input
							ref={inputRef}
							style={styles.input}
							value={name}
							onChange={(e) => setName(e.target.value)}
							// Escape is handled by the dialog container's onKeyDown.
							onKeyDown={(e) => {
								if (e.key === 'Enter') handleConfirm();
							}}
							placeholder="Pipeline name"
						/>
					</div>
					<div style={styles.buttonRow}>
						<button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
						<button style={styles.saveBtn(valid)} disabled={!valid} onClick={handleConfirm}>Save</button>
					</div>
				</div>
			</div>
		</div>
	);
};

export default SaveDialog;
