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
	const cancelRef = useRef(false);

	const refresh = useCallback(() => {
		if (!client || !isConnected) {
			setTree([]);
			setFlat([]);
			return;
		}

		cancelRef.current = false;
		setLoading(true);

		listRecursive(client, '')
			.then((nodes) => {
				if (cancelRef.current) return;
				setTree(nodes);
				setFlat(collectFlat(nodes, ''));
			})
			.catch((err) => {
				if (cancelRef.current) return;
				console.log('[usePipelineTree] Failed to load pipeline tree:', err);
				setTree([]);
				setFlat([]);
			})
			.finally(() => {
				if (!cancelRef.current) setLoading(false);
			});
	}, [client, isConnected]);

	useEffect(() => {
		refresh();
		return () => { cancelRef.current = true; };
	}, [refresh]);

	useEffect(() => {
		const handler = () => refresh();
		window.addEventListener('project:saved', handler);
		return () => window.removeEventListener('project:saved', handler);
	}, [refresh]);

	return { tree, flat, loading, refresh };
}
