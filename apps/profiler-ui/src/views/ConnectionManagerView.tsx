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
// CONNECTION MANAGER VIEW — profiler-ui's Archetype-C config
// =============================================================================
//
// Thin wrapper over the shared ConnectionManagerView. The shared component owns
// the whole page shell (ContentHeader, responsive ConnectionCard grid, dashed
// add tile, and the add/edit Modal); this file only supplies the profiler-server
// connection model, its form fields, and what create / open / delete do.
//
// Clicking a card opens a profiler tab for that server. Cards show the neutral
// "Disconnected" state (the landing does not track which servers currently have
// an open profiling tab).
// =============================================================================

import React from 'react';
import { ConnectionManagerView } from 'shell';
import type { IConnectionFormField } from 'shell';
import { useSavedConnections, addConnection, updateConnection, deleteConnection } from '../connections';
import type { SavedConnection } from '../connections';
import { getDocs } from '../docs';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Add/edit form fields for a profiler-server connection (rendered in order). */
const FIELDS: IConnectionFormField[] = [
	{ key: 'name', label: 'Name', placeholder: 'e.g. Local Dev Server', required: true, autoFocus: true },
	{ key: 'host', label: 'Host', placeholder: 'localhost' },
	{ key: 'port', label: 'Port', placeholder: '5565' },
];

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Connection manager landing page for the Profiler app (Archetype C).
 *
 * Delegates the page shell to the shared {@link ConnectionManagerView}; this
 * wrapper supplies only the app-specific data model and behaviour.
 */
const ProfilerConnectionManagerView: React.FC = () => {
	const connections = useSavedConnections();

	return (
		<ConnectionManagerView<SavedConnection>
			title="Profiler Connections"
			subtitle="Attach to a server to profile its process and pipeline engines."
			emptyDescription="Attach to a server to profile its process and pipeline engines."
			connections={connections}
			card={(conn) => ({
				name: conn.name,
				address: `${conn.host}:${conn.port}`,
				status: 'muted',
				statusLabel: 'Disconnected',
			})}
			fields={FIELDS}
			newValues={{ name: '', host: 'localhost', port: '5565' }}
			editValues={(conn) => ({ name: conn.name, host: conn.host, port: conn.port })}
			onCreate={(values) => {
				// Add the connection and immediately open it in a profiler tab.
				const name = values.name.trim();
				const host = values.host.trim();
				const port = values.port.trim();
				const id = addConnection({ name, host, port });
				getDocs()?.openStaticDocument(`conn:${id}`, name, { host, port });
			}}
			onUpdate={(conn, values) => {
				updateConnection(conn.id, {
					name: values.name.trim(),
					host: values.host.trim(),
					port: values.port.trim(),
				});
			}}
			onOpen={(conn) => {
				getDocs()?.openStaticDocument(`conn:${conn.id}`, conn.name, { host: conn.host, port: conn.port });
			}}
			onDelete={(conn) => {
				// The app owns the confirmation prompt (shared view just calls onDelete).
				if (confirm(`Delete connection "${conn.name}"?`)) deleteConnection(conn.id);
			}}
		/>
	);
};

export default ProfilerConnectionManagerView;
