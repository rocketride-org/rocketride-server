// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Avatar and AvatarGroup. */

import React from 'react';
import { Avatar, AvatarGroup } from 'shell';
import type { AvatarSize } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** The demo's team. */
const TEAM = ['Avery Chen', 'Blake Rivera', 'Casey Nguyen', 'Devon Patel', 'Emery Brooks', 'Finley Ortiz'].map((name) => ({ name }));

/** Live demo: single avatars in each tone and a group with overflow. */
const AvatarDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const size = knobs.size as AvatarSize;
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
			<Avatar name={String(knobs.name)} size={size} square={Boolean(knobs.square)} />
			<Avatar name="RocketRide Cloud" size={size} square />
			<AvatarGroup avatars={TEAM} max={Number(knobs.max)} size={size} />
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let squareAttr = '';
	if (knobs.square) squareAttr = ' square';
	return `import { Avatar, AvatarGroup } from 'shell';

<Avatar name="${String(knobs.name)}" size="${String(knobs.size)}"${squareAttr} />
<AvatarGroup avatars={members.map((m) => ({ name: m.name, src: m.photoUrl }))} max={${Number(knobs.max)}} />`;
}

/** The Avatar gallery entry. */
export const avatarEntry: IGalleryEntry = {
	id: 'avatar',
	name: 'Avatar / AvatarGroup',
	group: 'content',
	blurb: 'A person, org or agent as an image or initials. Initials sit on a stable per-name tint from the theme chart palette; broken images fall back to initials.',
	doc: 'Pass `decorative` when the name is already visible next to the avatar, so screen readers do not read it twice. AvatarGroup overlaps avatars and collapses the overflow into "+N".',
	knobs: [
		{ id: 'name', label: 'Name', kind: 'text', defaultValue: 'Avery Chen' },
		{ id: 'size', label: 'Size', kind: 'select', options: ['sm', 'md', 'lg'], defaultValue: 'md' },
		{ id: 'square', label: 'Square', kind: 'boolean', defaultValue: false },
		{ id: 'max', label: 'Group max', kind: 'number', defaultValue: 4 },
	],
	demo: AvatarDemo,
	code: buildCode,
	props: [
		{ name: 'name', type: 'string', dir: 'in', required: true, note: 'Accessible name, initials and color seed.' },
		{ name: 'src', type: 'string', dir: 'in', note: 'Image URL; initials when absent or broken.' },
		{ name: 'size', type: "'sm' | 'md' | 'lg'", dir: 'in', note: '22 / 28 / 40px. Default md.' },
		{ name: 'square', type: 'boolean', dir: 'in', note: 'Rounded square (orgs, apps, agents).' },
		{ name: 'decorative', type: 'boolean', dir: 'in', note: 'Hide from screen readers when the name is visible beside it.' },
		{ name: 'avatars / max', type: '{ name; src? }[] / number', dir: 'in', note: 'AvatarGroup - people and the cap before "+N" (default 4).' },
	],
};
