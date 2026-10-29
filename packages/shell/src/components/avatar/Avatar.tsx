// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Avatar and AvatarGroup — a person, org or agent as an image or initials.
 *
 * Without an image, the avatar shows up to two initials on a tint picked
 * deterministically from the name (the same name always gets the same
 * color), drawn from the theme's chart palette so it follows every theme.
 * A broken image falls back to initials. AvatarGroup overlaps a row of
 * avatars and collapses the overflow into a "+N" chip.
 *
 * An avatar next to the person's visible name is decorative; pass
 * `decorative` so screen readers do not read the name twice.
 *
 * Built on `.rr-avatar` and `.rr-avatar-group` from components.css.
 */

import React, { ReactNode, useState } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Avatar size: 22px, 28px (default) or 40px. */
export type AvatarSize = 'sm' | 'md' | 'lg';

/** Props for the {@link Avatar} component. */
export interface IAvatarProps {
	/** Display name: the accessible name, the initials and the color seed. */
	name: string;
	/** Image URL; initials show when absent or when it fails to load. */
	src?: string;
	/** Size. Defaults to `'md'`. */
	size?: AvatarSize;
	/** Rounded square instead of a circle (orgs, apps, agents). */
	square?: boolean;
	/** Hide from screen readers when the name is already visible beside it. */
	decorative?: boolean;
	/** Custom content in place of initials, e.g. an icon. */
	children?: ReactNode;
}

/** Props for the {@link AvatarGroup} component. */
export interface IAvatarGroupProps {
	/** The people to show, in order. */
	avatars: Pick<IAvatarProps, 'name' | 'src'>[];
	/** Most avatars shown before the rest collapse into "+N". Defaults to 4. */
	max?: number;
	/** Size for every avatar. Defaults to `'md'`. */
	size?: AvatarSize;
	/** Accessible name for the group. Defaults to the list of names. */
	ariaLabel?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Theme chart tokens avatars rotate through. */
export const AVATAR_TONES = ['--rr-chart-blue', '--rr-chart-green', '--rr-chart-yellow', '--rr-chart-purple', '--rr-chart-orange', '--rr-chart-red'];

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Up to two initials: first and last word, or the first two letters of a
 * single word. Emails use the part before the @.
 *
 * @param name - A display name or email.
 * @returns Upper-case initials, or `'?'` when nothing usable is left.
 */
export function getInitials(name: string): string {
	const base = name.split('@')[0];
	const words = base.split(/[\s._-]+/).filter((word) => word.length > 0);
	if (words.length === 0) return '?';
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	const first = words[0][0];
	const last = words[words.length - 1][0];
	return `${first}${last}`.toUpperCase();
}

/**
 * The chart token for a name: a stable hash of the lower-cased name, so the
 * same person always gets the same color.
 *
 * @param name - The color seed.
 * @returns One of {@link AVATAR_TONES}.
 */
export function getAvatarTone(name: string): string {
	let hash = 0;
	for (const char of name.toLowerCase()) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return AVATAR_TONES[hash % AVATAR_TONES.length];
}

/** The size modifier class for a size. */
function sizeClass(size: AvatarSize): string {
	if (size === 'sm') return ' rr-avatar--sm';
	if (size === 'lg') return ' rr-avatar--lg';
	return '';
}

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders one avatar.
 *
 * @param props - {@link IAvatarProps}.
 * @returns The avatar element.
 */
export function Avatar({ name, src, size = 'md', square = false, decorative = false, children }: IAvatarProps): React.ReactElement {
	const [hasImageFailed, setHasImageFailed] = useState(false);

	let classes = `rr-avatar${sizeClass(size)}`;
	if (square) classes += ' rr-avatar--square';

	const toneStyle = { '--rr-avatar-tone': `var(${getAvatarTone(name)})` } as React.CSSProperties;

	let role: string | undefined = 'img';
	let label: string | undefined = name;
	if (decorative) {
		role = undefined;
		label = undefined;
	}

	let content: ReactNode = getInitials(name);
	if (children) content = children;
	const isImageShown = Boolean(src) && !hasImageFailed;
	if (isImageShown) {
		content = <img src={src} alt="" onError={() => setHasImageFailed(true)} />;
	} else {
		classes += ' rr-avatar--toned';
	}

	return (
		<span className={classes} style={toneStyle} role={role} aria-label={label} aria-hidden={decorative || undefined} title={name}>
			{content}
		</span>
	);
}

/**
 * Renders an overlapping row of avatars with a "+N" overflow chip.
 *
 * @param props - {@link IAvatarGroupProps}.
 * @returns The group element.
 */
export function AvatarGroup({ avatars, max = 4, size = 'md', ariaLabel }: IAvatarGroupProps): React.ReactElement {
	const shown = avatars.slice(0, max);
	const hidden = avatars.slice(max);

	let label = ariaLabel;
	if (!label) label = avatars.map((avatar) => avatar.name).join(', ');

	return (
		<span className="rr-avatar-group" role="group" aria-label={label}>
			{shown.map((avatar, index) => (
				<Avatar key={`${avatar.name}-${index}`} name={avatar.name} src={avatar.src} size={size} decorative />
			))}
			{hidden.length > 0 && (
				<span className={`rr-avatar${sizeClass(size)} rr-avatar--overflow`} aria-hidden="true" title={hidden.map((avatar) => avatar.name).join(', ')}>
					+{hidden.length}
				</span>
			)}
		</span>
	);
}
