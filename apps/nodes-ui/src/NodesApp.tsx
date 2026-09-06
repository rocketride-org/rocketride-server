// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// NODE CATALOG APP — the storefront, wired to the engine.
//
// The screen itself is host-agnostic and lives in shared; this file is the
// adapter: it turns INodeCatalogHost into `rrext_node_catalog` calls and runs
// a chosen node through the same staged install the sidebar uses, so a node
// taken from the catalog and a capsule imported by hand arrive the same way.
//
// Installed nodes land in the caller's OWN store, which is what makes them
// materialize into the engine on the next run — no flags, no server restart.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { useShellConnection, type ShellAppProps } from 'shell';

import { installCapsule } from 'shared/modules/sidebar/capsuleInstall';
import { NodeCatalogView } from 'shared/modules/nodecatalog/NodeCatalogView';
import type { INodeCatalogEntry, INodeCatalogHost } from 'shared/modules/nodecatalog/types';

/**
 * The Node Catalog app — client area.
 *
 * Takes the connected client from the shell, like every other app here; with
 * no connection the catalog simply reads as empty.
 */
const NodesApp: React.FC<ShellAppProps> = (_props) => {
	const { client } = useShellConnection();
	const [installed, setInstalled] = useState<string[]>([]);

	/** Names already in this user's store, so a card can say "installed". */
	const refreshInstalled = useCallback(async () => {
		if (!client) return;
		try {
			const res = await client.call<{ nodes?: string[] }>('rrext_node_dev', { subcommand: 'list' });
			setInstalled(res?.nodes ?? []);
		} catch {
			setInstalled([]);
		}
	}, [client]);

	useEffect(() => {
		void refreshInstalled();
	}, [refreshInstalled]);

	const host: INodeCatalogHost = {
		list: async (search?: string) => {
			if (!client) return [];
			const res = await client.call<{ nodes?: INodeCatalogEntry[] }>('rrext_node_catalog', {
				subcommand: 'list',
				search: search ?? '',
			});
			return res?.nodes ?? [];
		},

		get: async (name: string) => {
			if (!client) throw new Error('not connected');
			return client.call('rrext_node_catalog', { subcommand: 'get', name });
		},

		install: async (entry: INodeCatalogEntry) => {
			if (!client) throw new Error('not connected');
			// Fetch, then hand the bytes to the same staged install the sidebar
			// uses: inspected and reported before anything is written.
			const fetched = await client.call<{ capsule: string }>('rrext_node_catalog', {
				subcommand: 'fetch',
				name: entry.name,
			});
			const result = await installCapsule(
				{
					inspect: (capsule) => client.call('rrext_node_dev', { subcommand: 'inspect', capsule }),
					install: (capsule) => client.call('rrext_node_dev', { subcommand: 'install', capsule }),
					// Taking a node from the catalog IS the consent; the report is
					// still produced, and a capsule that would not load is refused.
					confirm: async () => true,
				},
				fetched.capsule,
			);
			if (result.outcome !== 'installed') {
				throw new Error(result.error || `install ${result.outcome}`);
			}
			await refreshInstalled();
		},

		installed,
	};

	return <NodeCatalogView host={host} />;
};

export default NodesApp;
