// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Account module shared sub-components, constants, and helper functions.
 *
 * These small presentational primitives (Btn, Badge, Avatar, Modal, etc.)
 * are used across all AccountView tab panels. Keeping them in a single
 * file avoids circular imports and makes it easy to find every reusable piece.
 *
 * All styles delegate to commonStyles where possible; only account-specific
 * layout tokens that have no common equivalent are defined locally.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derives up to two initials from a display name, falling back to the first
 * character of the email address, and finally "U" if both are empty.
 *
 * @param name  - The user's display name (may be empty or whitespace).
 * @param email - The user's email address used as a fallback seed.
 * @returns A 1-2 character uppercase initials string.
 */
export function initials(name: string, email: string): string {
	if (name?.trim())
		return name
			.split(' ')
			.filter(Boolean)
			.slice(0, 2)
			.map((p) => p[0].toUpperCase())
			.join('');
	if (email?.trim()) return email[0].toUpperCase();
	return 'U';
}

/**
 * Deterministically maps a seed string to one of seven brand-aligned colors
 * using a simple polynomial hash, so the same name always yields the same color.
 *
 * @param seed - Any non-empty string (typically a display name or email).
 * @returns A CSS hex color string.
 */
export function avatarColor(seed: string): string {
	const colors = ['#4a6fa5', '#6b7b8d', '#5b7a6e', '#7c6d82', '#5c798f', '#6e7f6b', '#8a7968'];
	// Polynomial rolling hash — keeps the result in unsigned 32-bit range via >>> 0.
	let h = 0;
	for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
	return colors[h % colors.length];
}

/**
 * Converts an ISO timestamp (or null) into a human-readable relative time
 * string such as "Just now", "5m ago", "3h ago", or "2d ago".
 *
 * @param iso - An ISO 8601 date string, or null / undefined for never.
 * @returns A concise relative time string.
 */
export function relativeTime(iso: string | null): string {
	if (!iso) return 'Never';
	const diff = Date.now() - new Date(iso).getTime();
	const m = Math.floor(diff / 60000);
	if (m < 1) return 'Just now';
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Human-friendly display labels for permission keys.
 * Used by PermPill and anywhere else a permission needs a readable name.
 */
export const PERM_DISPLAY: Record<string, string> = {
	'org.admin': 'Org: Admin',
	'team.admin': 'Team: Admin',
	'task.control': 'Task: Control',
	'task.monitor': 'Task: Monitor',
	'task.debug': 'Task: Debug',
	'task.data': 'Task: Data',
	'task.store': 'Task: Storage',
};

/**
 * Static list of known permission keys with human-readable descriptions.
 * Drives both PermGrid and the add-member / edit-perms modals.
 */
export const PERMS = [
	{ key: 'task.control', desc: 'Start / stop tasks' },
	{ key: 'task.data', desc: 'Submit data to tasks' },
	{ key: 'task.monitor', desc: 'View status & events' },
	{ key: 'task.store', desc: 'Access file storage' },
	{ key: 'team.admin', desc: 'Manage team members' },
];

/**
 * Predefined expiry duration options for API key creation.
 * `days: null` represents "no expiry".
 */
export const EXPIRY_OPTS = [
	{ label: '30 days', days: 30 },
	{ label: '90 days', days: 90 },
	{ label: '1 year', days: 365 },
	{ label: 'No expiry', days: null },
];

// =============================================================================
// ELEMENT STYLES
// =============================================================================

/**
 * Account-specific layout tokens that have no common equivalent.
 * All generic styles (card, button, input, badge, etc.) come from commonStyles.
 */
export const S = {
	// ── Row list layout ──────────────────────────────────────────────────────
	/** Vertical flex container that stacks row items without gaps. */
	rowList: { display: 'flex', flexDirection: 'column' as const } as CSSProperties,
	/** A single data row with horizontal layout, gap, padding, and a bottom border. */
	rowItem: { display: 'flex', alignItems: 'center', gap: 11, padding: '11px 18px', borderBottom: '1px solid var(--rr-border)', transition: 'background 0.1s' } as CSSProperties,
	/** Flex-growing info column inside a row item. */
	rowInfo: { flex: 1, minWidth: 0 } as CSSProperties,
	/** Primary text label within a row item. */
	rowName: { fontSize: 12, fontWeight: 500, color: 'var(--rr-text-primary)', marginBottom: 2 } as CSSProperties,
	/** Right-aligned action button cluster inside a row item. */
	rowActions: { display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 } as CSSProperties,

	// ── Form fields ──────────────────────────────────────────────────────────
	/** Two-column grid layout for side-by-side form fields. */
	fieldRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 } as CSSProperties,
	/** Single form field wrapper with bottom margin. */
	field: { marginBottom: 14 } as CSSProperties,
	/** Uppercase label above a form field — delegates to commonStyles. */
	fieldLabel: { ...commonStyles.labelUppercase, marginBottom: 6 } as CSSProperties,

	// ── Permissions ──────────────────────────────────────────────────────────
	/** Wrapping flex row for permission pills. */
	perms: { display: 'flex', flexWrap: 'wrap' as const, gap: 3, marginTop: 4 } as CSSProperties,
};

// =============================================================================
// BADGE
// =============================================================================

/** Per-variant color overrides applied on top of commonStyles.badge. */
const badgeVariants: Record<string, CSSProperties> = {
	active: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-color-success)' },
	admin: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-brand)' },
	member: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-text-secondary)' },
	pending: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-color-warning)' },
	expired: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-color-error)' },
};

/**
 * A small inline pill badge that delegates to commonStyles.badge for shape
 * and applies per-variant color overrides.
 *
 * @param variant  - Determines the background and text color.
 * @param children - Badge label content.
 */
export const Badge: React.FC<{ variant: 'active' | 'admin' | 'member' | 'pending' | 'expired'; children: React.ReactNode }> = ({ variant, children }) => (
	<span style={{ ...commonStyles.badge, ...badgeVariants[variant] }}>
		{/* Active variant gets a green dot indicator to the left of its label. */}
		{variant === 'active' && <span style={commonStyles.indicatorSuccess} />}
		{children}
	</span>
);

// =============================================================================
// PERM PILL
// =============================================================================

/**
 * Renders a single permission string as a compact colored pill.
 * "admin" and wildcard "*" permissions use the brand orange; all others use blue.
 *
 * @param perm - The permission key string to display.
 */
export const PermPill: React.FC<{ perm: string }> = ({ perm }) => {
	// Distinguish elevated permissions (admin/*) from standard capability flags.
	const isAdmin = perm === 'team.admin' || perm === 'org.admin' || perm === '*';
	return (
		<span
			style={{
				...commonStyles.badge,
				padding: '1px 6px',
				borderRadius: 3,
				color: isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)',
				border: `1px solid ${isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)'}`,
				background: 'var(--rr-bg-surface-alt)',
			}}
		>
			{PERM_DISPLAY[perm] ?? perm}
		</span>
	);
};

// =============================================================================
// AVATAR
// =============================================================================

/**
 * A circular (or square-rounded) avatar that renders generated initials on a
 * deterministic color background. No image loading required.
 *
 * @param name   - Display name used for initials and color seed.
 * @param email  - Fallback seed when name is empty.
 * @param size   - Diameter in pixels; defaults to 28.
 * @param square - When true, renders with rounded-square corners instead of a circle.
 */
export const Avatar: React.FC<{ name: string; email?: string; size?: number; square?: boolean }> = ({ name, email = '', size = 28, square }) => (
	<div
		style={{
			...commonStyles.iconBox,
			width: size,
			height: size,
			borderRadius: square ? 7 : '50%',
			background: avatarColor(name || email),
			fontSize: size * 0.38,
			fontWeight: 700,
			color: 'var(--rr-fg-button)',
		}}
	>
		{initials(name, email)}
	</div>
);

// =============================================================================
// ROW ICON
// =============================================================================

/**
 * A small square icon container used at the leading edge of a row item.
 * Wraps any inline content (emoji, SVG, text) in a consistent sized box.
 *
 * @param children - Icon content (emoji, SVG, or text).
 */
export const RowIcon: React.FC<{ children: React.ReactNode }> = ({ children }) => <div style={{ ...commonStyles.iconBox, width: 28, height: 28, borderRadius: 6, background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', fontSize: 13 }}>{children}</div>;

// =============================================================================
// MODAL SHELL
// =============================================================================

/**
 * A reusable overlay modal shell with a title bar, scrollable body, and
 * footer action row. Uses commonStyles.modalOverlay for the backdrop.
 *
 * @param title    - Text shown in the modal header.
 * @param onClose  - Called when the user clicks the close button or the backdrop.
 * @param footer   - Action buttons rendered in the modal footer.
 * @param children - Body content rendered inside the modal.
 */
export const Modal: React.FC<{ title: string; onClose: () => void; footer: React.ReactNode; children: React.ReactNode }> = ({ title, onClose, footer, children }) => (
	<div
		style={commonStyles.modalOverlay}
		onClick={(e) => {
			// Clicking the outer overlay (but not the card itself) dismisses the modal.
			if (e.target === e.currentTarget) onClose();
		}}
	>
		<div style={commonStyles.modalDialog}>
			<div style={commonStyles.modalHeader}>
				<span style={{ fontSize: 14, fontWeight: 700, color: 'var(--rr-text-primary)' }}>{title}</span>
				<button
					onClick={onClose}
					style={{
						...commonStyles.buttonSecondary,
						border: 'none',
						background: 'transparent',
						padding: 0,
						fontSize: 17,
						lineHeight: 1,
						color: 'var(--rr-text-secondary)',
					}}
				>
					&#x2715;
				</button>
			</div>
			<div style={commonStyles.modalBody}>{children}</div>
			<div style={commonStyles.modalFooter}>{footer}</div>
		</div>
	</div>
);

// =============================================================================
// PERM CHECKBOX GRID
// =============================================================================

/**
 * An interactive 2-column grid of permission checkboxes.
 * Clicking a cell toggles the corresponding permission key in the `value` array.
 *
 * @param value    - The currently selected permission keys.
 * @param onChange - Called with the updated array after each toggle.
 */
export const PermGrid: React.FC<{ value: string[]; onChange: (v: string[]) => void }> = ({ value, onChange }) => {
	/** Toggles a single permission key in or out of the selection array. */
	const toggle = (key: string) => {
		const next = value.includes(key) ? value.filter((p) => p !== key) : [...value, key];
		onChange(next);
	};
	return (
		<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
			{PERMS.map(({ key, desc }) => {
				const checked = value.includes(key);
				// Admin permission uses orange highlight; capability flags use blue.
				const isAdmin = key === 'team.admin';
				const accent = isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)';
				return (
					<div
						key={key}
						onClick={() => toggle(key)}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 7,
							padding: '7px 9px',
							background: checked ? 'var(--rr-bg-list-active)' : 'var(--rr-bg-surface-alt)',
							border: `1px solid ${checked ? accent : 'var(--rr-border)'}`,
							borderRadius: 5,
							cursor: 'pointer',
							transition: 'border-color 0.12s',
						}}
					>
						{/* Custom checkbox square */}
						<div
							style={{
								width: 13,
								height: 13,
								borderRadius: 3,
								flexShrink: 0,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								fontSize: 9,
								border: `1px solid ${checked ? accent : 'var(--rr-border-input)'}`,
								background: checked ? accent : 'var(--rr-bg-input)',
								color: 'var(--rr-fg-button)',
							}}
						>
							{checked && '\u2713'}
						</div>
						<div>
							<div style={{ fontSize: 11, fontWeight: 500, color: checked ? 'var(--rr-fg-button)' : 'var(--rr-text-primary)' }}>{PERM_DISPLAY[key] || key}</div>
							<div style={{ fontSize: 10, color: checked ? 'var(--rr-fg-button)' : 'var(--rr-text-secondary)', opacity: checked ? 0.8 : 1 }}>{desc}</div>
						</div>
					</div>
				);
			})}
		</div>
	);
};

// =============================================================================
// EXPIRY SELECTOR
// =============================================================================

/**
 * A segmented control for selecting an API key expiry duration.
 * Uses commonStyles.toggleButton pattern for consistent toggle styling.
 *
 * @param value    - Currently selected duration in days, or null for no expiry.
 * @param onChange - Called with the newly selected duration.
 */
export const ExpiryOpts: React.FC<{ value: number | null; onChange: (v: number | null) => void }> = ({ value, onChange }) => (
	<div style={commonStyles.toggleGroup}>
		{EXPIRY_OPTS.map(({ label, days }) => (
			<button type="button" key={label} onClick={() => onChange(days)} style={commonStyles.toggleButton(value === days)}>
				{label}
			</button>
		))}
	</div>
);
