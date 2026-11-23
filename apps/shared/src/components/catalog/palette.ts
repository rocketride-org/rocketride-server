// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CATALOG PALETTE — the colours and faces the catalog picker draws with
// =============================================================================
//
// The picker never chooses a theme. Every colour it draws comes from one
// palette the HOST hands it. A host that hands none gets SHELL_PALETTE, whose
// values are the shell's theme variables, so the picker follows the shell's
// light and dark themes. A host with its own look (home-ui's light store)
// passes its own values and the picker looks the same whatever the shell
// theme is.
//
// Every value is used as a CSS value as it stands (a colour, a variable, a
// gradient stop): nothing in the picker computes on one.

import type { AppManifestEntry } from 'shell';

/** How the catalog body lays its entries out; the host owns the toggle. */
export type CatalogView = 'grid' | 'list';

/** The colours and faces the picker draws with. */
export interface ICatalogPalette {
	/** The page background, and the fill of small chips drawn on a surface. */
	bg: string;
	/** A card, a row and the detail panel's blocks. */
	bgSurface: string;
	/** A hovered card or row, and the tint that frames an icon. */
	bgSurfaceHover: string;
	/** Names and headings. */
	textPri: string;
	/** Descriptions and small labels. */
	textSec: string;
	/** Body copy and sublabels. */
	textTri: string;
	/** The faintest labels and the empty messages. */
	textMuted: string;
	/** Hairlines. */
	border: string;
	/** Outlines of pills and buttons. */
	borderStrong: string;
	/** An outline under the pointer. */
	borderHover: string;
	/** The one accent: actions and the selected pill. */
	accent: string;
	/** Text on the accent. */
	accentText: string;
	/** A faint wash of the accent (the "Open" badge). */
	accentSoft: string;
	/** The text face. */
	font: string;
	/** The face of addresses, ids and parameter names. */
	fontMono: string;
	/** A repeating background image for the detail panel (a CSS `url(...)`); absent = none. */
	texture?: string;
	/** The icon an entry shows; absent = the entry's own `icon`. A host with theme-matched icons answers here. */
	iconOf?: (app: Pick<AppManifestEntry, 'id' | 'icon'>) => string | undefined;
}

/** The palette of a host that passes none: the shell's theme variables. */
export const SHELL_PALETTE: ICatalogPalette = {
	bg: 'var(--rr-bg-default)',
	bgSurface: 'var(--rr-bg-paper)',
	bgSurfaceHover: 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))',
	textPri: 'var(--rr-text-primary)',
	textSec: 'var(--rr-text-secondary)',
	textTri: 'var(--rr-text-secondary)',
	textMuted: 'var(--rr-text-disabled, var(--rr-text-secondary))',
	border: 'var(--rr-border)',
	borderStrong: 'var(--rr-border)',
	borderHover: 'var(--rr-text-secondary)',
	accent: 'var(--rr-brand)',
	accentText: 'var(--rr-fg-button, #fff)',
	accentSoft: 'color-mix(in srgb, var(--rr-brand) 12%, transparent)',
	font: 'var(--rr-font-family)',
	fontMono: "var(--rr-font-mono, Consolas, 'Courier New', monospace)",
};

/**
 * The icon an entry shows under a palette.
 *
 * @param palette - The palette in use.
 * @param app - The entry.
 * @returns The icon's `src`, or undefined when the entry has none (the caller draws the first letter).
 */
export function iconOf(palette: ICatalogPalette, app: Pick<AppManifestEntry, 'id' | 'icon'> | null | undefined): string | undefined {
	if (!app) return undefined;
	return palette.iconOf ? palette.iconOf(app) : app.icon;
}
