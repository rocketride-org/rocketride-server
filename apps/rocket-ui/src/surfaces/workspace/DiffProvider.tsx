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
// DIFF VIEWER — pending-change review tab (`diff:<path>` static docs)
// =============================================================================
//
// Unified diff of one path's staged change: the first-touch BEFORE content
// against the current effective AFTER content, straight from the staged
// view's diff() — the same truth commit verification uses. Re-computed on
// every view tick, so further edits, a discard, or a commit refresh an open
// tab live.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { getStagedWorkspace } from './vfs/workspace';
import { diffLines } from '../../utils/lineDiff';
import type { DiffLine } from '../../utils/lineDiff';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		overflow: 'hidden',
		background: 'var(--rr-bg-default)',
	} as CSSProperties,
	header: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '6px 14px',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	stat: (color: string): CSSProperties => ({
		color,
		fontWeight: 600,
	}),
	body: {
		flex: 1,
		minHeight: 0,
		overflow: 'auto',
	} as CSSProperties,
	line: (type: DiffLine['type']): CSSProperties => ({
		display: 'flex',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		lineHeight: 1.6,
		whiteSpace: 'pre',
		background:
			type === 'add' ? 'var(--rr-scm-added-bg, rgba(129, 184, 139, 0.18))'
			: type === 'del' ? 'var(--rr-scm-deleted-bg, rgba(199, 78, 57, 0.18))'
			: 'transparent',
		color: 'var(--rr-text-primary)',
	}),
	gutter: {
		width: 22,
		flexShrink: 0,
		textAlign: 'center' as const,
		color: 'var(--rr-text-secondary)',
		userSelect: 'none' as const,
	} as CSSProperties,
	text: {
		flex: 1,
		minWidth: 0,
		paddingRight: 14,
	} as CSSProperties,
	empty: {
		...commonStyles.textMuted,
		padding: 24,
		textAlign: 'center' as const,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for the DiffProvider document. */
interface DiffProviderProps {
	/** View-relative workspace path (from the `diff:` static-doc uri). */
	path: string;
}

/**
 * Unified diff tab for one pending change.
 *
 * @param props - See {@link DiffProviderProps}.
 */
const DiffProvider: React.FC<DiffProviderProps> = ({ path }) => {
	const [lines, setLines] = useState<DiffLine[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// step: concurrent loads race during an edit burst — only the NEWEST
	// call's result may land (and none after unmount)
	const seqRef = useRef(0);
	const load = useCallback(async () => {
		const seq = ++seqRef.current;
		try {
			const { before, after } = await getStagedWorkspace().diff(path);
			if (seq !== seqRef.current) return;
			setLines(diffLines(before, after));
			setError(null);
		} catch (err) {
			if (seq !== seqRef.current) return;
			setLines(null);
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [path]);

	// Compute on mount; recompute on every view tick (edit/discard/commit).
	useEffect(() => {
		void load();
		const unsubscribe = getStagedWorkspace().subscribe(() => void load());
		return () => {
			seqRef.current += 1;
			unsubscribe();
		};
	}, [load]);

	const added = lines?.filter((l) => l.type === 'add').length ?? 0;
	const deleted = lines?.filter((l) => l.type === 'del').length ?? 0;
	const unchanged = lines !== null && added === 0 && deleted === 0;

	return (
		<div style={S.container}>
			<div style={S.header}>
				<span style={commonStyles.textEllipsis}>{path}</span>
				<span style={S.stat('var(--rr-scm-added, #81b88b)')}>+{added}</span>
				<span style={S.stat('var(--rr-scm-deleted, #c74e39)')}>-{deleted}</span>
			</div>
			<div style={S.body}>
				{error && <div style={S.empty}>Could not compute the diff: {error}</div>}
				{!error && lines === null && <div style={S.empty}>Loading...</div>}
				{!error && unchanged && <div style={S.empty}>No pending changes for this file — it matches the committed state.</div>}
				{!error && lines !== null && !unchanged && lines.map((l, i) => (
					<div key={i} style={S.line(l.type)}>
						<span style={S.gutter}>{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ''}</span>
						<span style={S.text}>{l.text}</span>
					</div>
				))}
			</div>
		</div>
	);
};

export default DiffProvider;
