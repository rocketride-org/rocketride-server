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
// SQL-UI — CONNECTION EDITOR BODY (the add/edit form as a document)
// =============================================================================
//
// Shared by both hosts: the full app's `connedit:` document and the dev
// tool's `edit:` frame. The save itself goes through SqlEnv (the full app's
// engine core, or the controller's `sql.saveConnection` op), so the list is
// only ever written where it is owned.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { EmptyState } from 'shell';
import { useConnectionRecord } from '../connectionRecord';
import type { SavedSqlConnection } from '../connect';
import NewConnectionModal from './NewConnectionModal';
import { DatabaseIcon } from '../icons';

const styles = {
	// Centred empty state.
	welcome: {
		display: 'flex',
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,
};

/**
 * The connection editor as a document body, shared by both hosts: resolves
 * the editing target from the store and runs the page-chrome form. After a
 * NEW connection saves, `onOpenSaved` opens its workbench.
 */
export const ConnectionEditorBody: React.FC<{
	/** The connection id being edited, or null for the add form. */
	connId: string | null;
	/** A dev-tool frame whose tool sidebar (its controller) is not open: an edit target cannot be read until it is. */
	sidebarClosed?: boolean;
	/** A dev-tool frame whose controller is starting (being summoned, or not yet saying who is signed in). */
	starting?: boolean;
	/** A dev-tool frame whose controller vouches for no one: nothing can be saved. */
	signedOut?: boolean;
	/** Close this editor document. */
	onCloseSelf: () => void;
	/** Open the workbench of a freshly added connection. */
	onOpenSaved: (saved: SavedSqlConnection) => void;
}> = ({ connId, sidebarClosed = false, starting = false, signedOut = false, onCloseSelf, onOpenSaved }) => {
	const { record: editing, status } = useConnectionRecord(connId);

	// Nobody to save for: say so before any form (a Save would only be refused).
	if (signedOut) return <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Waiting for sign-in" description="Sign in to RocketRide to add or edit connections." /></div>;
	// An edit target the starting sidebar has not shared yet is not "loading the
	// list"; the add form waits too (its Save would wait for the sidebar).
	if (starting && (!connId || !editing)) return <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Starting SQL Explorer…" description="The SQL Explorer sidebar is starting. This connection can be edited once it is ready." /></div>;

	if (sidebarClosed && !connId) return <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Open the SQL Explorer sidebar to connect" description="The sidebar saves your connections. A connection can be added once the sidebar is open." /></div>;

	// An edit target that is not in the store yet (list still loading) or is
	// gone (deleted elsewhere) must not silently become an ADD form.
	if (connId && !editing) {
		if (sidebarClosed) return <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Open the SQL Explorer sidebar to connect" description="The sidebar holds your saved connections. This connection can be edited once the sidebar is open." /></div>;
		return status === 'ready'
			? <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Connection not found" description="This saved connection no longer exists." /></div>
			: <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Loading…" description="Reading your saved connections." /></div>;
	}

	return (
		<NewConnectionModal
			page
			editing={editing}
			onClose={onCloseSelf}
			onSaved={(saved) => { if (!connId) onOpenSaved(saved); }}
		/>
	);
};

export default ConnectionEditorBody;
