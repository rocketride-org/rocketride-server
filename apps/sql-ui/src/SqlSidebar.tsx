// =============================================================================
// MIT License
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
// SQL-UI — SIDEBAR (navigation menu + active connection's schema tree)
// =============================================================================

import React, { useMemo } from 'react';
import { useShellConnection } from 'shell';
import { Explorer, SidebarMenu } from 'shell';
import type { ViewMenu } from 'shell';
import { NOOP_VFS } from 'shell';
import type { ExplorerEntry } from 'shell';
import { useSqlEndpoints } from './connect';
import { refreshSchema, useSchema } from './schema/schemaStore';
import { requestTableRecord, useActiveConnection } from './navigation';
import { CONNECTIONS_URI, getDocs } from './docs';
import { DatabaseIcon } from './icons';

/**
 * SQL Explorer sidebar: the app navigation menu on top, and — while a
 * connection document is active — the stock Explorer tree showing that
 * connection's tables with their columns as children. Clicking a table opens
 * its record drawer in the active workbench's Overview page.
 *
 * Passed to AppLayout's `sidebar` prop by SqlApp — part of the app's one
 * tree, sharing the Documents singleton and navigation pub/sub directly.
 */
const SqlSidebar: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	const { endpoints } = useSqlEndpoints();

	// The connection document currently focused in the client area.
	const activeKey = useActiveConnection();
	const snapshot = useSchema(activeKey);
	const activeEndpoint = useMemo(() => endpoints.find((e) => e.key === activeKey) ?? null, [endpoints, activeKey]);

	// ── Navigation menu ──────────────────────────────────────────────────────
	// One entry today; count reflects live discovery (hidden while 0).
	const menu: ViewMenu = useMemo(
		() => ({
			entries: [
				{
					id: 'connections',
					label: 'Connections',
					icon: <DatabaseIcon />,
					...(endpoints.length > 0 ? { count: endpoints.length } : {}),
				},
			],
		}),
		[endpoints.length]
	);

	// ── Schema tree entries ──────────────────────────────────────────────────
	// Tables as file entries; each table's columns as its children, with the
	// datatype in the child's provider slot.
	const entries = useMemo<ExplorerEntry[]>(() => {
		const tables = snapshot.schema?.tables ?? {};
		return Object.entries(tables).map(([name, def]) => ({
			path: name,
			type: 'file',
			children: def.columns.map((col) => ({
				id: `${name}:${col.column}`,
				name: col.column,
				provider: col.type,
			})),
		}));
	}, [snapshot.schema]);

	return (
		<>
			<SidebarMenu menu={menu} activeId={activeKey ? '' : 'connections'} onSelect={() => getDocs()?.openStaticDocument(CONNECTIONS_URI, 'Connections')} sectionLabel="SQL Explorer" />

			{/* Schema tree for the active connection document. */}
			{activeKey && activeEndpoint && snapshot.status === 'ready' && (
				<Explorer
					vfs={NOOP_VFS}
					config={{
						title: snapshot.schema?.database ?? activeEndpoint.nodeName,
						extensions: null,
						emptyMessage: 'No tables',
						allowFolders: false,
					}}
					entries={entries}
					isConnected={isConnected}
					onOpenFile={(path) => requestTableRecord(activeKey, path)}
					onRefresh={() => {
						if (client) void refreshSchema(client, activeEndpoint);
					}}
				/>
			)}
		</>
	);
};

export default SqlSidebar;
