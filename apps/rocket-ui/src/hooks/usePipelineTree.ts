// =============================================================================
// usePipelineTree — Recursive pipeline file tree from the server store
// =============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RocketRideClient } from 'shell';
import { listProjectDir, displayName as projectDisplayName } from '../utils/projectStore';

// =============================================================================
// TYPES
// =============================================================================

export type TreeNode =
	| { type: 'dir'; name: string; path: string; children: TreeNode[] }
	| { type: 'file'; name: string; path: string };

export interface FlatEntry {
	/** Relative path without extension, e.g. "folderA/my-pipe" */
	path: string;
	/** Display label: "{name} (parentFolder)" or just "{name}" if at root */
	displayName: string;
}

// =============================================================================
// HELPERS
// =============================================================================

async function listRecursive(client: RocketRideClient, relPath: string): Promise<TreeNode[]> {
	const result = await listProjectDir(client, relPath);
	const nodes: TreeNode[] = [];

	for (const entry of result.entries) {
		const childRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
		if (entry.type === 'dir') {
			const children = await listRecursive(client, childRelPath);
			nodes.push({ type: 'dir', name: entry.name, path: childRelPath, children });
		} else if (entry.name.endsWith('.pipe')) {
			nodes.push({ type: 'file', name: entry.name, path: childRelPath });
		}
	}

	return nodes;
}

function collectFlat(nodes: TreeNode[], parentFolder: string): FlatEntry[] {
	const entries: FlatEntry[] = [];
	for (const node of nodes) {
		if (node.type === 'file') {
			const label = projectDisplayName(node.name);
			const displayName = parentFolder ? `${label} (${parentFolder})` : label;
			entries.push({ path: node.path, displayName });
		} else {
			entries.push(...collectFlat(node.children, node.name));
		}
	}
	return entries;
}

// =============================================================================
// HOOK
// =============================================================================

export function usePipelineTree(client: RocketRideClient | null, isConnected: boolean) {
	const [tree, setTree] = useState<TreeNode[]>([]);
	const [flat, setFlat] = useState<FlatEntry[]>([]);
	const [loading, setLoading] = useState(false);
	// Monotonic load counter: only the newest load may commit — a slower
	// earlier run must not overwrite a newer run's results.
	const fetchSeq = useRef(0);

	const refresh = useCallback(() => {
		if (!client || !isConnected) {
			// Bump the counter so any in-flight load is invalidated before the clear.
			fetchSeq.current++;
			setTree([]);
			setFlat([]);
			return;
		}

		const mine = ++fetchSeq.current;
		setLoading(true);

		listRecursive(client, '')
			.then((nodes) => {
				if (mine !== fetchSeq.current) return;
				setTree(nodes);
				setFlat(collectFlat(nodes, ''));
			})
			.catch((err) => {
				if (mine !== fetchSeq.current) return;
				console.log('[usePipelineTree] Failed to load pipeline tree:', err);
				setTree([]);
				setFlat([]);
			})
			.finally(() => {
				if (mine === fetchSeq.current) setLoading(false);
			});
	}, [client, isConnected]);

	useEffect(() => {
		refresh();
		// Unmount (or refresh identity change): invalidate any in-flight load.
		return () => { fetchSeq.current++; };
	}, [refresh]);

	useEffect(() => {
		const handler = () => refresh();
		window.addEventListener('project:saved', handler);
		return () => window.removeEventListener('project:saved', handler);
	}, [refresh]);

	return { tree, flat, loading, refresh };
}
