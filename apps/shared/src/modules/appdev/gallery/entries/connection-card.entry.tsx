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
// CONNECTION CARD — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the ConnectionCard source card (Archetype C vocabulary). */

import React from 'react';
import { ConnectionCard, ConnectionCardAdd } from 'shell';
import type { IConnectionCardProps } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Status label per status variant - what real callers render. */
const STATUS_LABELS: Record<string, string> = {
	success: 'Connected',
	muted: 'Disconnected',
	error: 'Error',
};

/** Live demo: the knob-driven card beside the add tile. */
const ConnectionCardDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const status = String(knobs.status) as IConnectionCardProps['status'];
	return (
		<div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', maxWidth: 560 }}>
			<div style={{ width: 250 }}>
				<ConnectionCard name="Production" address="wss://app.rocketride.io" status={status} statusLabel={STATUS_LABELS[status]} connected={Boolean(knobs.connected)} onEdit={() => undefined} onDelete={() => undefined} onClick={() => undefined} />
			</div>
			<div style={{ width: 250 }}>
				<ConnectionCardAdd label="New Connection" onClick={() => undefined} />
			</div>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const connectedAttr = knobs.connected ? '\n\tconnected' : '';
	return `import { ConnectionCard, ConnectionCardAdd } from 'shell';

<ConnectionCard
	name="Production"
	address="wss://app.rocketride.io"
	status="${String(knobs.status)}"
	statusLabel="${STATUS_LABELS[String(knobs.status)]}"${connectedAttr}
	onEdit={editConnection}
	onDelete={deleteConnection}
	onClick={selectConnection}
/>
<ConnectionCardAdd label="New Connection" onClick={createConnection} />`;
};

/** The ConnectionCard gallery entry. */
export const connectionCardEntry: IGalleryEntry = {
	id: 'connection-card',
	name: 'ConnectionCard',
	group: 'content',
	blurb: 'Source card: icon, name, address, StatusBadge, and hover-revealed edit/delete actions - plus the matching ConnectionCardAdd tile. The Archetype C source vocabulary.',
	doc: `ConnectionCard is part of the shell surface: apps import it (with \`ConnectionCardAdd\`) from \`shell\`.`,
	knobs: [
		{ id: 'status', label: 'Status', kind: 'select', options: ['success', 'muted', 'error'], defaultValue: 'success' },
		{ id: 'connected', label: 'Connected', kind: 'boolean', defaultValue: true },
	],
	demo: ConnectionCardDemo,
	code: buildCode,
	props: [
		{ name: 'icon', type: 'ReactNode', dir: 'in', note: "Optional source icon (rendered at 30px, inherits the card's icon colour)." },
		{ name: 'name', type: 'string', dir: 'in', required: true, note: 'Source name.' },
		{ name: 'address', type: 'string', dir: 'in', required: true, note: 'Source address / endpoint.' },
		{ name: 'status', type: "'success' | 'muted' | 'error'", dir: 'in', required: true, note: "StatusBadge variant for the source's state." },
		{ name: 'statusLabel', type: 'string', dir: 'in', required: true, note: 'StatusBadge label, e.g. "Connected" / "Disconnected".' },
		{ name: 'connected', type: 'boolean', dir: 'in', note: 'When true, the card carries the brand border and brand icon colour.' },
		{ name: 'onEdit', type: '() => void', dir: 'out', note: 'Edit action - reveals the pencil icon on hover.' },
		{ name: 'onDelete', type: '() => void', dir: 'out', note: 'Delete action - reveals the trash icon on hover.' },
		{ name: 'onClick', type: '() => void', dir: 'out', note: 'Select action for the whole card.' },
	],
};
