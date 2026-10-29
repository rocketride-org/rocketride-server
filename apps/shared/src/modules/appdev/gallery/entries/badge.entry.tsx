// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Badge (corner count / dot). */

import React from 'react';
import { Avatar, Badge, IconButton } from 'shell';
import type { BadgeTone } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a count on an icon button and a dot on an avatar. */
const BadgeDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
		<Badge count={Number(knobs.count)} tone={knobs.tone as BadgeTone} label="unread notifications" showZero={Boolean(knobs.showZero)}>
			<IconButton label="Notifications" tooltip={false}>
				🔔
			</IconButton>
		</Badge>
		<Badge dot tone="error" label="offline">
			<Avatar name="Devon Patel" />
		</Badge>
	</div>
);

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Badge, IconButton } from 'shell';

<Badge count={${Number(knobs.count)}} tone="${String(knobs.tone)}" label="unread notifications">
	<IconButton label="Notifications"><BellIcon /></IconButton>
</Badge>`;
}

/** The Badge gallery entry. */
export const badgeEntry: IGalleryEntry = {
	id: 'badge',
	name: 'Badge',
	group: 'content',
	blurb: 'A count or dot pinned to the corner of an icon, avatar or tab. Counts cap at "99+"; zero hides unless showZero.',
	doc: 'The badge is visual; `label` tells screen readers what the number means ("3 unread notifications"). For a standalone status pill use StatusBadge.',
	knobs: [
		{ id: 'count', label: 'Count', kind: 'number', defaultValue: 3 },
		{ id: 'tone', label: 'Tone', kind: 'select', options: ['accent', 'error'], defaultValue: 'accent' },
		{ id: 'showZero', label: 'Show zero', kind: 'boolean', defaultValue: false },
	],
	demo: BadgeDemo,
	code: buildCode,
	props: [
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'The element the badge is pinned to.' },
		{ name: 'count', type: 'number', dir: 'in', note: 'The number; ignored with dot.' },
		{ name: 'max', type: 'number', dir: 'in', note: 'Cap before "max+". Default 99.' },
		{ name: 'dot', type: 'boolean', dir: 'in', note: 'Plain dot instead of a number.' },
		{ name: 'showZero', type: 'boolean', dir: 'in', note: 'Keep visible at zero.' },
		{ name: 'tone', type: "'accent' | 'error'", dir: 'in', note: 'Default accent.' },
		{ name: 'label', type: 'string', dir: 'in', note: 'Meaning for screen readers, read after the count.' },
	],
};
