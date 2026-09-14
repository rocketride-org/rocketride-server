// Copyright (c) 2026 Aparavi Software AG. MIT License.
import React from 'react';
import { getDocs } from '../../docs';

/**
 * A "Saved: <basename>" chip shown after {@link AgentSessionView}'s "Save to
 * project" action. Click opens the pipe in the canvas via the same
 * `getDocs().openDocument` call the sidebar Explorer rows use
 * (SidebarProvider.tsx `handleOpenFile`) — the Documents store read is fresh
 * on open, so the just-saved pipe renders immediately with no deep-link race.
 */
export function SavedPipeChip({ pipePath }: { pipePath: string }): React.JSX.Element {
	const name = pipePath.split('/').pop() ?? pipePath;
	return (
		<button title={`Open ${pipePath} in the canvas`} onClick={() => getDocs()?.openDocument(pipePath)} style={{ borderRadius: 12, padding: '2px 10px' }}>
			Saved: {name}
		</button>
	);
}
