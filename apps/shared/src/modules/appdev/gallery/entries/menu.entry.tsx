// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Menu and MenuButton. */

import React, { useState } from 'react';
import { MenuButton } from 'shell';
import type { MenuEntry } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a pipeline "more" menu with a checkable row and a destructive action. */
const MenuDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [isAutoRun, setIsAutoRun] = useState(true);
	const [lastAction, setLastAction] = useState('none');

	const items: MenuEntry[] = [{ type: 'label', label: 'Pipeline' }, { id: 'open', label: 'Open', shortcut: '⌘O' }, { id: 'duplicate', label: 'Duplicate', shortcut: '⌘D' }, { id: 'auto-run', label: 'Run on save', checked: isAutoRun }, { id: 'export', label: 'Export', disabled: true }, { type: 'divider' }, { id: 'delete', label: 'Delete', danger: true }];

	/** Reports the chosen action and flips the checkable row. */
	function handleSelect(id: string): void {
		setLastAction(id);
		if (id === 'auto-run') setIsAutoRun(!isAutoRun);
	}

	let trigger = <MenuButton label="Actions" items={items} onSelect={handleSelect} />;
	if (knobs.iconOnly) {
		trigger = <MenuButton icon="⋯" ariaLabel="Pipeline actions" items={items} onSelect={handleSelect} />;
	}

	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
			{trigger}
			<span className="rr-text-caption">Last action: {lastAction}</span>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let trigger = 'label="Actions"';
	if (knobs.iconOnly) trigger = 'icon={<MoreIcon />} ariaLabel="Pipeline actions"';
	return `import { MenuButton } from 'shell';

<MenuButton
	${trigger}
	items={[
		{ id: 'open', label: 'Open', shortcut: '⌘O' },
		{ id: 'auto-run', label: 'Run on save', checked: autoRun },
		{ type: 'divider' },
		{ id: 'delete', label: 'Delete', danger: true },
	]}
	onSelect={handleAction}
/>`;
}

/** The Menu / MenuButton gallery entry. */
export const menuEntry: IGalleryEntry = {
	id: 'menu',
	name: 'Menu / MenuButton',
	group: 'content',
	blurb: 'Anchored action menu from a data array - row "more" menus, toolbar overflow, context menus. MenuButton wires a trigger to it.',
	doc: 'WAI-ARIA menu pattern: focus moves onto the items; arrows move and wrap, Home/End jump, typing jumps to a matching item, Enter/Space activate, Escape closes and returns focus, Tab closes. Rows can be actions (with icon, shortcut, danger, checked), dividers, or labels. Use the controlled `Menu` with your own anchor for context menus.',
	knobs: [{ id: 'iconOnly', label: 'Icon-only trigger', kind: 'boolean', defaultValue: false }],
	demo: MenuDemo,
	code: buildCode,
	props: [
		{ name: 'items', type: 'MenuEntry[]', dir: 'in', required: true, note: "Actions { id, label, icon?, shortcut?, disabled?, danger?, checked? }, { type: 'divider' }, { type: 'label', label }." },
		{ name: 'label / icon', type: 'ReactNode', dir: 'in', note: 'MenuButton trigger content. Icon-only needs ariaLabel.' },
		{ name: 'variant / small / disabled / title', type: '...', dir: 'in', note: 'MenuButton trigger styling (Button variants).' },
		{ name: 'open / anchorRef', type: 'boolean / RefObject', dir: 'in', note: 'Menu (controlled) only.' },
		{ name: 'placement', type: 'OverlayPlacement', dir: 'in', note: "Default 'bottom-start'." },
		{ name: 'initialFocus', type: "'first' | 'last'", dir: 'in', note: 'Menu only - which item gets focus on open.' },
		{ name: 'onSelect', type: '(id: string) => void', dir: 'out', required: true, note: 'Fired with the chosen action id, then the menu closes.' },
		{ name: 'onClose', type: '() => void', dir: 'out', note: 'Menu (controlled) only - the menu asks to close.' },
	],
};
