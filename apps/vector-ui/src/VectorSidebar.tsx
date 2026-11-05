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
// VECTOR-UI - SIDEBAR (navigation: Connections, and every open connection)
// =============================================================================
//
// The rail opens collapsed (the descriptor asks for it): the console, not the
// navigation, is the reason to open the app. Expanded, it lists Connections
// and every vector store found, each opening its console.
// =============================================================================

import React, { useMemo } from 'react';
import { SidebarMenu } from 'shell';
import type { ViewMenu } from 'shell';
import { useActiveConnection, useVectorEndpoints } from './adapters/react';
import { getDocs } from './docs';
import { CONNECTIONS_URI } from './vector/addresses';
import { VectorIcon } from './icons';
import { openConsole } from './views/ConnectionsView';

/** Props: none. The sidebar reads shared stores, like the other apps' sidebars. */
const VectorSidebar: React.FC = () => {
	const { endpoints } = useVectorEndpoints();
	const activeKey = useActiveConnection();
	const menu: ViewMenu = useMemo(
		() => ({
			entries: [{ id: 'connections', label: 'Connections', icon: <VectorIcon />, ...(endpoints.length > 0 ? { count: endpoints.length } : {}) }, ...endpoints.map((endpoint) => ({ id: endpoint.key, label: `${endpoint.nodeName || endpoint.nodeId} · ${endpoint.pipelineName}`, icon: <VectorIcon /> }))],
		}),
		[endpoints]
	);
	return (
		<SidebarMenu
			menu={menu}
			activeId={activeKey ?? 'connections'}
			onSelect={(id: string) => {
				if (id === 'connections') {
					getDocs()?.openStaticDocument(CONNECTIONS_URI, 'Connections');
					return;
				}
				const endpoint = endpoints.find((e) => e.key === id);
				if (endpoint) openConsole(endpoint);
			}}
			sectionLabel="Vector Explorer"
		/>
	);
};

export default VectorSidebar;
