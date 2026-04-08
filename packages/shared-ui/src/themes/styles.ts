// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Common style definitions for shared-ui components.
 *
 * All styles use --rr-* CSS custom property tokens so they automatically
 * adapt to light/dark themes and VS Code theme overrides.
 *
 * Usage:
 *   import { commonStyles } from '../../themes/styles';
 *   <div style={commonStyles.card}> ... </div>
 */

import type { CSSProperties } from 'react';

// =============================================================================
// CARDS
// =============================================================================

/** Card with optional header — bordered container with rounded corners. */
const card: CSSProperties = {
	background: 'var(--rr-bg-paper)',
	border: '1px solid var(--rr-border)',
	borderRadius: 8,
	overflow: 'hidden',
};

/** Card header — sits at the top of a card. */
const cardHeader: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	padding: '12px 16px',
	background: 'var(--rr-bg-surface-alt)',
	fontSize: 13,
	fontWeight: 600,
	color: 'var(--rr-text-primary)',
};

/** Card body — content area with standard padding. */
const cardBody: CSSProperties = {
	padding: 16,
};

/** Card with no header — simple bordered container with padding. */
const cardFlat: CSSProperties = {
	...card,
	padding: 16,
};

// =============================================================================
// SECTIONS
// =============================================================================

/** Section container — vertical stack with gap. */
const section: CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	gap: 16,
	width: '100%',
};

/** Section header — label on left, controls on right. */
const sectionHeader: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
};

/** Section header label text. */
const sectionHeaderLabel: CSSProperties = {
	fontSize: 13,
	fontWeight: 600,
	color: 'var(--rr-text-primary)',
};

// =============================================================================
// BUTTONS
// =============================================================================

/** Primary action button — brand-colored background. */
const buttonPrimary: CSSProperties = {
	padding: '6px 16px',
	fontSize: 'var(--rr-font-size-widget)',
	fontWeight: 500,
	borderRadius: 6,
	border: 'none',
	cursor: 'pointer',
	backgroundColor: 'var(--rr-brand)',
	color: 'var(--rr-fg-button)',
	transition: 'opacity 0.15s',
};

/** Danger button — error-colored background. */
const buttonDanger: CSSProperties = {
	...buttonPrimary,
	backgroundColor: 'var(--rr-color-error)',
};

/** Secondary/outline button — transparent with border. */
const buttonSecondary: CSSProperties = {
	padding: '6px 16px',
	fontSize: 'var(--rr-font-size-widget)',
	fontWeight: 500,
	borderRadius: 6,
	border: '1px solid var(--rr-border)',
	cursor: 'pointer',
	backgroundColor: 'var(--rr-bg-paper)',
	color: 'var(--rr-text-secondary)',
	transition: 'opacity 0.15s',
};

/** Disabled button modifier — reduces opacity. */
const buttonDisabled: CSSProperties = {
	opacity: 0.5,
	cursor: 'default',
};

/** Small toggle button — used in groups (e.g. time range, view mode). */
const toggleButton = (active: boolean): CSSProperties => ({
	padding: '2px 8px',
	fontSize: 11,
	border: active ? '1px solid var(--rr-brand)' : '1px solid var(--rr-border)',
	borderRadius: 3,
	cursor: 'pointer',
	backgroundColor: active ? 'var(--rr-brand)' : 'transparent',
	color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-secondary)',
	transition: 'background-color 0.15s, color 0.15s',
});

/** Toggle button group container. */
const toggleGroup: CSSProperties = {
	display: 'flex',
	gap: 4,
};

// =============================================================================
// LAYOUT
// =============================================================================

/** Two-column header — content left, actions right. */
const splitHeader: CSSProperties = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'flex-start',
	gap: 16,
	marginBottom: 16,
};

/** Tab content area — standard padding and scroll for all tab panels.
 *  Top padding clears the overlay tab bar (15px padding + 34px pill + 15px gap = 64px + 15px). */
const tabContent: CSSProperties = {
	padding: '79px 30px 0',
	overflow: 'auto',
	flex: 1,
	minHeight: 0,
	maxWidth: 800,
	margin: '0 auto',
};

/** @deprecated Use tabContent instead. */
const viewPadding: CSSProperties = {
	padding: 16,
	flex: 1,
	minHeight: 0,
	overflow: 'auto',
};

// =============================================================================
// TEXT
// =============================================================================

/** Empty state message — centered, muted text. */
const empty: CSSProperties = {
	color: 'var(--rr-text-disabled)',
	textAlign: 'center',
	padding: 32,
};

/** Muted secondary text. */
const textMuted: CSSProperties = {
	color: 'var(--rr-text-secondary)',
	fontSize: 12,
};

// =============================================================================
// TABLES
// =============================================================================

/** Table header cell. */
const tableHeader: CSSProperties = {
	textAlign: 'left',
	padding: '8px 14px',
	fontSize: 10,
	textTransform: 'uppercase',
	letterSpacing: '0.6px',
	color: 'var(--rr-text-disabled)',
	borderBottom: '1px solid var(--rr-border)',
	fontWeight: 600,
};

/** Table body cell. */
const tableCell: CSSProperties = {
	padding: '10px 14px',
	borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
	verticalAlign: 'middle',
};

// =============================================================================
// STATUS INDICATORS
// =============================================================================

const indicatorBase: CSSProperties = {
	width: 8,
	height: 8,
	borderRadius: '50%',
};

const indicatorSuccess: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-color-success)',
	boxShadow: '0 0 4px var(--rr-color-success)',
};

const indicatorInfo: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-color-info)',
};

const indicatorWarning: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-color-warning)',
};

const indicatorError: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-color-error)',
};

const indicatorMuted: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-text-secondary)',
	opacity: 0.5,
};

// =============================================================================
// TEXT UTILITIES
// =============================================================================

/** Truncate text with ellipsis. Add flex: 1 + minWidth: 0 for flex children. */
const textEllipsis: CSSProperties = {
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
};

/** Monospace font family. */
const fontMono: CSSProperties = {
	fontFamily: 'var(--rr-font-mono, monospace)',
};

/** Uppercase label — small, bold, spaced, secondary colour. */
const labelUppercase: CSSProperties = {
	fontSize: 11,
	fontWeight: 600,
	textTransform: 'uppercase',
	letterSpacing: '0.5px',
	color: 'var(--rr-text-secondary)',
};

// =============================================================================
// OVERLAYS
// =============================================================================

/** Full-screen modal backdrop. */
const overlay: CSSProperties = {
	position: 'fixed',
	inset: 0,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	backgroundColor: 'rgba(0, 0, 0, 0.5)',
	zIndex: 10000,
};

// =============================================================================
// EXPORT
// =============================================================================

export const commonStyles = {
	// Cards
	card,
	cardHeader,
	cardBody,
	cardFlat,

	// Sections
	section,
	sectionHeader,
	sectionHeaderLabel,

	// Buttons
	buttonPrimary,
	buttonDanger,
	buttonSecondary,
	buttonDisabled,
	toggleButton,
	toggleGroup,

	// Layout
	splitHeader,
	tabContent,
	viewPadding,

	// Text
	empty,
	textMuted,
	textEllipsis,
	fontMono,
	labelUppercase,

	// Overlays
	overlay,

	// Tables
	tableHeader,
	tableCell,

	// Status indicators
	indicatorBase,
	indicatorSuccess,
	indicatorInfo,
	indicatorWarning,
	indicatorError,
	indicatorMuted,
};
