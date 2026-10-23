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
// CONNECTION OVERLAYS — the app-root host for sidebar-requested dialogs
// =============================================================================
//
// The shell Modal/ConfirmDialog render fixed markup in place (no portal), so
// the SIDEBAR never mounts them — it posts a ConnectionOverlayRequest and
// this component, rendered at the app root (outside any transformed drawer),
// shows the add/edit modal or the delete confirm.
// =============================================================================

import React, { useCallback } from 'react';
import { ConfirmDialog } from 'shell';
import { useSqlEnv } from '../sqlEnv';
import { requestConnectionOverlay, useConnectionOverlay } from '../navigation';
import NewConnectionModal from './NewConnectionModal';

/**
 * Renders the currently requested connection overlay (or nothing).
 * Mounted once by SqlApp / SqlDevTool at the app root.
 */
const ConnectionOverlays: React.FC = () => {
	const env = useSqlEnv();
	const request = useConnectionOverlay();

	const close = useCallback(() => requestConnectionOverlay(null), []);

	/** Delete-confirm action: drop the record where the list is owned; a
	 *  direct connection's temp pipeline is stopped first, best effort (the
	 *  TTL reaps it otherwise). */
	const confirmDelete = useCallback(() => {
		if (request?.kind !== 'delete') return;
		void env.deleteConnection(request.conn).catch(() => undefined);
		close();
	}, [request, env, close]);

	if (!request) return null;

	if (request.kind === 'modal') {
		return <NewConnectionModal editing={request.editing} onClose={close} />;
	}

	return (
		<ConfirmDialog
			title="Delete connection?"
			message={`"${request.conn.name}" will be removed${request.conn.mode === 'direct' ? ' and its temporary pipeline stopped' : ''}.`}
			confirmLabel="Delete"
			cancelLabel="Cancel"
			destructive
			onConfirm={confirmDelete}
			onCancel={close}
		/>
	);
};

export default ConnectionOverlays;
