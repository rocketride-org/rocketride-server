// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for List. */

import React, { useState } from 'react';
import { Avatar, List, StatusBadge } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** The demo's members. */
const MEMBERS = [
	{ id: 'ac', name: 'Avery Chen', email: 'avery@example.com', role: 'Owner' },
	{ id: 'br', name: 'Blake Rivera', email: 'blake@example.com', role: 'Admin' },
	{ id: 'dp', name: 'Devon Patel', email: 'devon@example.com', role: 'Member' },
	{ id: 'eb', name: 'Emery Brooks', email: 'emery@example.com', role: 'Invited' },
];

/** Live demo: a member list, optionally selectable. */
const ListDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [selectedId, setSelectedId] = useState<string | null>('br');
	const items = MEMBERS.map((member) => {
		let trailing: React.ReactNode = member.role;
		if (member.role === 'Invited') trailing = <StatusBadge variant="info">Invited</StatusBadge>;
		return { id: member.id, primary: member.name, secondary: member.email, leading: <Avatar name={member.name} decorative />, trailing, disabled: member.role === 'Invited' };
	});

	let onSelect: ((id: string) => void) | undefined;
	if (knobs.selectable) onSelect = setSelectedId;

	return (
		<div style={{ maxWidth: 420 }}>
			<List items={items} onSelect={onSelect} selectedId={selectedId} dividers={Boolean(knobs.dividers)} dense={Boolean(knobs.dense)} ariaLabel="Members" />
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (knobs.selectable) attrs += ' onSelect={setSelected} selectedId={selected}';
	if (knobs.dividers) attrs += ' dividers';
	if (knobs.dense) attrs += ' dense';
	return `import { Avatar, List } from 'shell';

<List
	ariaLabel="Members"
	items={members.map((m) => ({ id: m.id, primary: m.name, secondary: m.email, leading: <Avatar name={m.name} decorative />, trailing: m.role }))}${attrs}
/>`;
}

/** The List gallery entry. */
export const listEntry: IGalleryEntry = {
	id: 'list',
	name: 'List',
	group: 'content',
	blurb: 'Rows with primary and secondary text, a leading icon or avatar, and trailing meta. Static, or a single-select listbox when onSelect is set.',
	doc: 'Selectable lists have one Tab stop; Arrow Up/Down, Home/End and typeahead move, Enter/Space select. Use Tree for nested data and Table for columns.',
	knobs: [
		{ id: 'selectable', label: 'Selectable', kind: 'boolean', defaultValue: true },
		{ id: 'dividers', label: 'Dividers', kind: 'boolean', defaultValue: false },
		{ id: 'dense', label: 'Dense', kind: 'boolean', defaultValue: false },
	],
	demo: ListDemo,
	code: buildCode,
	props: [
		{ name: 'items', type: '{ id; primary; secondary?; leading?; trailing?; disabled? }[]', dir: 'in', required: true, note: 'Rows in order.' },
		{ name: 'selectedId', type: 'string | null', dir: 'in', note: 'Selected row (selectable lists).' },
		{ name: 'dividers / dense', type: 'boolean', dir: 'in', note: 'Row separators / tighter rows.' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: 'Accessible name (required when selectable).' },
		{ name: 'emptyText', type: 'ReactNode', dir: 'in', note: 'Shown when there are no rows.' },
		{ name: 'onSelect', type: '(id: string) => void', dir: 'out', note: 'Makes the list selectable.' },
	],
};
