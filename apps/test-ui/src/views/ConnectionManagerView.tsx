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
// CONNECTION MANAGER VIEW — test-ui's Archetype-C config
// =============================================================================
//
// Thin wrapper over the shared ConnectionManagerView. The shared component owns
// the whole page shell (ContentHeader, responsive ConnectionCard grid, dashed
// add tile, and the add/edit Modal); this file only supplies the test-server
// connection model, its form fields, and what create / open / delete do.
//
// Clicking a card opens the connection as a test-session tab. This view only
// renders while no session tabs are open, so cards always show the neutral
// "Disconnected" state.
// =============================================================================

import React from 'react';
import { ConnectionManagerView } from 'shared/modules/connection-manager/ConnectionManagerView';
import type { IConnectionFormField } from 'shared/modules/connection-manager/ConnectionManagerView';
import {
	useSavedConnections, addConnection, updateConnection, deleteConnection,
	type SavedConnection,
} from '../connections';
import { getDocs } from '../docs';
import { openConnection } from '../TestApp';
import { DEFAULT_CONFIG } from '../session';

// =============================================================================
// CONSTANTS
// =============================================================================

/** All load-test phases seeded onto a newly-created connection. */
const ALL_PHASES = ['sweep', 'stress', 'flood', 'pipe', 'chaos', 'hammer'];

/** Add/edit form fields for a test-server connection (rendered in order). */
const FIELDS: IConnectionFormField[] = [
	{ key: 'name', label: 'Name', placeholder: 'e.g. Local OSS Server', required: true, autoFocus: true },
	{ key: 'url', label: 'URL', placeholder: 'localhost:5565' },
	{ key: 'apiKey', label: 'API Key', placeholder: 'Optional', secret: true },
];

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Connection manager landing page for the Test app (Archetype C).
 *
 * Delegates the page shell to the shared {@link ConnectionManagerView}; this
 * wrapper supplies only the app-specific data model and behaviour.
 */
const TestConnectionManagerView: React.FC = () => {
	const connections = useSavedConnections();

	return (
		<ConnectionManagerView<SavedConnection>
			title="Test Server Connections"
			subtitle="Attach to a test server to run load and stress scenarios."
			emptyDescription="Attach to a test server to run load and stress scenarios against it."
			connections={connections}
			card={(conn) => ({ name: conn.name, address: conn.url, status: 'muted', statusLabel: 'Disconnected' })}
			fields={FIELDS}
			newValues={{ name: '', url: 'localhost:5565', apiKey: '' }}
			editValues={(conn) => ({ name: conn.name, url: conn.url, apiKey: conn.apiKey || '' })}
			onCreate={(values) => {
				// Build the connection once — addConnection() assigns the id, then the
				// same object (plus id) is what gets opened as a session tab.
				const newConn: Omit<SavedConnection, 'id'> = {
					name: values.name.trim(),
					url: values.url.trim(),
					apiKey: values.apiKey.trim(),
					config: { ...DEFAULT_CONFIG },
					selectedPhases: [...ALL_PHASES],
				};
				const id = addConnection(newConn);
				const docs = getDocs();
				if (docs) openConnection(docs, { ...newConn, id });
			}}
			onUpdate={(conn, values) => {
				updateConnection(conn.id, {
					name: values.name.trim(),
					url: values.url.trim(),
					apiKey: values.apiKey.trim(),
				});
			}}
			onOpen={(conn) => {
				const docs = getDocs();
				if (docs) openConnection(docs, conn);
			}}
			onDelete={(conn) => {
				// The app owns the confirmation prompt (shared view just calls onDelete).
				if (confirm(`Delete connection "${conn.name}"?`)) deleteConnection(conn.id);
			}}
		/>
	);
};

export default TestConnectionManagerView;
