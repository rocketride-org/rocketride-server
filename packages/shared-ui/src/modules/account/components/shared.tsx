// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Account module shared sub-components, constants, and helper functions.
 *
 * These small presentational primitives (Btn, Badge, Avatar, Modal, etc.)
 * are used across all five AccountView tab panels. Keeping them in a single
 * file avoids circular imports and makes it easy to find every reusable piece.
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
	const colors = ['#f7901f', '#3794ff', '#a78bfa', '#34d399', '#f59e0b', '#ec4899', '#14b8a6'];
	// Polynomial rolling hash - keeps the result in unsigned 32-bit range via >>> 0.
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
 * Static list of known permission keys with human-readable descriptions.
 * Drives both PermGrid and the add-member / edit-perms modals.
 */
export const PERMS = [
	{ key: 'admin', desc: 'Manage team members' },
	{ key: 'task.control', desc: 'Start / stop tasks' },
	{ key: 'task.monitor', desc: 'View status & events' },
	{ key: 'task.debug', desc: 'Attach debugger' },
	{ key: 'task.data', desc: 'Submit data to tasks' },
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
 * Shared inline-style tokens used by sub-components throughout AccountView.
 * Keeping these in a single object avoids repetition while staying within the
 * "styles inline in the component file" rule.
 */
export const S = {
	/** Vertical flex container that stacks row items without gaps. */
	rowList: { display: 'flex', flexDirection: 'column' as const } as CSSProperties,
	/** A single data row with horizontal layout, gap, padding, and a bottom border. */
	rowItem: { display: 'flex', alignItems: 'center', gap: 11, padding: '11px 18px', borderBottom: '1px solid var(--rr-border)', transition: 'background 0.1s' } as CSSProperties,
	/** Flex-growing info column inside a row item. */
	rowInfo: { flex: 1, minWidth: 0 } as CSSProperties,
	/** Primary text label within a row item. */
	rowName: { fontSize: 12, fontWeight: 500, color: 'var(--rr-text-primary)', marginBottom: 2 } as CSSProperties,
	/** Secondary/supplemental text line within a row item. */
	rowSub: { fontSize: 11, color: 'var(--rr-text-secondary)' } as CSSProperties,
	/** Right-aligned action button cluster inside a row item. */
	rowActions: { display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 } as CSSProperties,
	/** Right-aligned timestamp column; shrinks but does not grow. */
	rowTs: { fontSize: 10, color: 'var(--rr-text-disabled)', textAlign: 'right' as const, flexShrink: 0, lineHeight: 1.6 } as CSSProperties,

	/** Large circular avatar used in the profile card header. */
	profileAvLg: { width: 52, height: 52, borderRadius: '50%', background: 'var(--rr-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, color: 'var(--rr-fg-button)', flexShrink: 0 } as CSSProperties,
	/** Display name text beneath the large avatar. */
	profileAvName: { fontSize: 14, fontWeight: 700, color: 'var(--rr-text-primary)', marginBottom: 2 } as CSSProperties,
	/** Subtitle text (email / username) beneath the display name. */
	profileAvSub: { fontSize: 11, color: 'var(--rr-text-secondary)' } as CSSProperties,

	/** Two-column grid layout for side-by-side form fields. */
	fieldRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 } as CSSProperties,
	/** Single form field wrapper with bottom margin. */
	field: { marginBottom: 14 } as CSSProperties,
	/** Uppercase label above a form field, sourced from commonStyles. */
	fieldLabel: { ...commonStyles.labelUppercase, marginBottom: 6 } as CSSProperties,
	/** Small hint text shown below a form field. */
	fieldHint: { fontSize: 10, color: 'var(--rr-text-disabled)', marginTop: 4 } as CSSProperties,
	/** Full-width styled text input. */
	fieldInput: { width: '100%', padding: '7px 11px', background: 'var(--rr-bg-input)', border: '1px solid var(--rr-border-input)', borderRadius: 5, color: 'var(--rr-text-primary)', fontSize: 12, fontFamily: 'var(--rr-font-family)', outline: 'none', boxSizing: 'border-box' as const } as CSSProperties,
	/** Full-width styled select - same as fieldInput but preserves native dropdown arrow. */
	selectInput: { width: '100%', padding: '7px 11px', background: 'var(--rr-bg-input)', border: '1px solid var(--rr-border-input)', borderRadius: 5, color: 'var(--rr-text-primary)', fontSize: 12, fontFamily: 'var(--rr-font-family)', outline: 'none', boxSizing: 'border-box' as const, cursor: 'pointer' } as CSSProperties,

	/** Wrapping flex row for permission pills. */
	perms: { display: 'flex', flexWrap: 'wrap' as const, gap: 3, marginTop: 4 } as CSSProperties,

	/** Red-tinted bordered box that groups destructive actions. */
	dangerZone: { border: '1px solid var(--rr-color-error)', borderRadius: 9, overflow: 'hidden', marginBottom: 14, marginTop: 20 } as CSSProperties,
	/** Header bar inside the danger zone. */
	dangerHdr: { padding: '10px 18px', background: 'var(--rr-bg-surface-alt)', borderBottom: '1px solid var(--rr-border)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px', color: 'var(--rr-color-error)' } as CSSProperties,
	/** Horizontal row inside the danger zone that pairs a description with an action button. */
	dangerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px' } as CSSProperties,
	/** Bold label text for a danger-zone action. */
	dangerLabel: { fontSize: 12, fontWeight: 500, color: 'var(--rr-text-primary)', marginBottom: 2 } as CSSProperties,
	/** Descriptive sub-text for a danger-zone action. */
	dangerDesc: { fontSize: 11, color: 'var(--rr-text-secondary)' } as CSSProperties,

	/** Compact inline tag showing a team name next to a key or member row. */
	teamTag: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--rr-text-secondary)', background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', borderRadius: 3, padding: '1px 5px' } as CSSProperties,
	/** Small de-emphasized footnote text below a card. */
	footerNote: { fontSize: 10, color: 'var(--rr-text-disabled)', marginTop: 7 } as CSSProperties,
	/** Subtle info strip used to surface read-only metadata (e.g. revealed key details). */
	infoStrip: { background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', borderRadius: 7, padding: '10px 13px', fontSize: 11, color: 'var(--rr-text-secondary)', lineHeight: 1.6 } as CSSProperties,

	/** Card-style modal container with elevated box shadow. */
	modal: { ...commonStyles.card, borderRadius: 10, width: 440, maxWidth: '95vw', boxShadow: '0 20px 50px var(--rr-shadow-widget)' } as CSSProperties,
	/** Flex header row inside a modal with title text and close button. */
	modalHdr: { ...commonStyles.cardHeader, padding: '16px 20px 13px', fontSize: 14, fontWeight: 700 } as CSSProperties,
	/** Title text element inside the modal header. */
	modalTitle: { fontSize: 14, fontWeight: 700, color: 'var(--rr-text-primary)' } as CSSProperties,
	/** Padded body region of a modal dialog. */
	modalBody: { padding: 20 } as CSSProperties,
	/** Footer row with right-aligned action buttons, separated by a top border. */
	modalFoot: { padding: '13px 20px', borderTop: '1px solid var(--rr-border)', display: 'flex', justifyContent: 'flex-end', gap: 8 } as CSSProperties,

	/** Highlighted box used to display a newly created API key. */
	revealBox: { background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', borderRadius: 7, padding: 12, marginBottom: 12 } as CSSProperties,
	/** Uppercase section label inside the reveal box. */
	revealLabel: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px', color: 'var(--rr-text-secondary)', marginBottom: 7 } as CSSProperties,
	/** Horizontal row pairing the key value with the copy button. */
	revealRow: { display: 'flex', alignItems: 'center', gap: 7 } as CSSProperties,
	/** Monospace display for the raw API key string. */
	revealKey: { flex: 1, fontFamily: "'Consolas','Courier New',monospace", fontSize: 11, color: 'var(--rr-text-primary)', background: 'var(--rr-bg-input)', border: '1px solid var(--rr-border-input)', borderRadius: 5, padding: '7px 10px', wordBreak: 'break-all' as const, lineHeight: 1.5 } as CSSProperties,
	/** Warning message below the reveal box reminding the user to copy the key. */
	revealWarn: { fontSize: 10, color: 'var(--rr-color-warning)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 7 } as CSSProperties,
};

// =============================================================================
// BUTTON
// =============================================================================

/** The visual style variant for the Btn component. */
export type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/**
 * A lightweight styled button used throughout AccountView.
 * Selects a base style from commonStyles based on the `variant` prop and
 * optionally applies size reduction via the `small` flag.
 */
export const Btn: React.FC<{
	/** Visual variant - defaults to "secondary". */
	variant?: BtnVariant;
	/** Click handler forwarded to the underlying button element. */
	onClick?: (e?: React.MouseEvent) => void;
	/** When true, renders the button in a disabled state with muted styling. */
	disabled?: boolean;
	/** When true, reduces padding and font size for compact row contexts. */
	small?: boolean;
	children: React.ReactNode;
	/** Additional inline styles merged on top of the variant base. */
	style?: CSSProperties;
}> = ({ variant = 'secondary', onClick, disabled, small, children, style }) => {
	// Pick the base style object that corresponds to the requested variant.
	const base: CSSProperties = variant === 'primary' ? commonStyles.buttonPrimary : variant === 'danger' ? commonStyles.buttonDanger : variant === 'ghost' ? { ...commonStyles.buttonSecondary, border: 'none', background: 'transparent' } : commonStyles.buttonSecondary;
	const sizeOverride: CSSProperties = small ? { padding: '3px 9px', fontSize: 11 } : {};
	return (
		<button onClick={onClick} disabled={disabled} style={{ ...base, ...sizeOverride, ...(disabled ? commonStyles.buttonDisabled : {}), whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 5, ...style }}>
			{children}
		</button>
	);
};

// =============================================================================
// BADGE
// =============================================================================

/**
 * A small inline pill badge used to communicate status or role at a glance.
 * Each variant maps to a distinct background/text color combination.
 */
export const Badge: React.FC<{ variant: 'active' | 'admin' | 'member' | 'pending' | 'expired'; children: React.ReactNode }> = ({ variant, children }) => {
	/** Per-variant color overrides applied on top of the shared base shape. */
	const variants: Record<string, CSSProperties> = {
		active: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-color-success)' },
		admin: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-brand)' },
		member: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-text-secondary)' },
		pending: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-color-warning)' },
		expired: { background: 'var(--rr-bg-surface-alt)', color: 'var(--rr-color-error)' },
	};
	return (
		<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 9, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px', ...variants[variant] }}>
			{/* Active variant gets a green dot indicator to the left of its label. */}
			{variant === 'active' && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--rr-color-success)' }} />}
			{children}
		</span>
	);
};

// =============================================================================
// PERM PILL
// =============================================================================

/**
 * Renders a single permission string as a compact colored pill.
 * "admin" and wildcard "*" permissions use the brand orange; all others use blue.
 */
export const PermPill: React.FC<{ perm: string }> = ({ perm }) => {
	// Distinguish elevated permissions (admin/*) from standard capability flags.
	const isAdmin = perm === 'admin' || perm === '*';
	return (
		<span
			style={{
				fontSize: 10,
				fontWeight: 600,
				padding: '1px 6px',
				borderRadius: 3,
				background: 'var(--rr-bg-surface-alt)',
				color: isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)',
				border: `1px solid ${isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)'}`,
			}}
		>
			{perm}
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
			width: size,
			height: size,
			borderRadius: square ? 7 : '50%',
			background: avatarColor(name || email),
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			fontSize: size * 0.38,
			fontWeight: 700,
			color: 'var(--rr-fg-button)',
			flexShrink: 0,
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
 */
export const RowIcon: React.FC<{ children: React.ReactNode }> = ({ children }) => <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>{children}</div>;

// =============================================================================
// MODAL SHELL
// =============================================================================

/**
 * A reusable overlay modal shell with a title bar, scrollable body, and
 * footer action row. Clicking the backdrop calls `onClose`.
 *
 * @param title    - Text shown in the modal header.
 * @param onClose  - Called when the user clicks the close button or the backdrop.
 * @param footer   - Action buttons rendered in the modal footer.
 * @param children - Body content rendered inside the modal.
 */
export const Modal: React.FC<{ title: string; onClose: () => void; footer: React.ReactNode; children: React.ReactNode }> = ({ title, onClose, footer, children }) => (
	// Clicking the outer overlay (but not the card itself) dismisses the modal.
	<div
		style={commonStyles.overlay}
		onClick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
	>
		<div style={S.modal}>
			<div style={S.modalHdr}>
				<span style={S.modalTitle}>{title}</span>
				<button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--rr-text-secondary)', cursor: 'pointer', fontSize: 17, lineHeight: 1 }}>
					&#x2715;
				</button>
			</div>
			<div style={S.modalBody}>{children}</div>
			<div style={S.modalFoot}>{footer}</div>
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
				const isAdmin = key === 'admin';
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
							border: `1px solid ${checked ? (isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)') : 'var(--rr-border)'}`,
							borderRadius: 5,
							cursor: 'pointer',
							transition: 'border-color 0.12s',
						}}
					>
						{/* Mini custom checkbox square */}
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
								border: `1px solid ${checked ? (isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)') : 'var(--rr-border-input)'}`,
								background: checked ? (isAdmin ? 'var(--rr-brand)' : 'var(--rr-color-info)') : 'var(--rr-bg-input)',
								color: 'var(--rr-fg-button)',
							}}
						>
							{checked && '\u2713'}
						</div>
						<div>
							<div style={{ fontSize: 11, fontWeight: 500, color: 'var(--rr-text-primary)' }}>{key}</div>
							<div style={{ fontSize: 10, color: 'var(--rr-text-secondary)' }}>{desc}</div>
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
 * The active option is highlighted in the brand color; clicking any option calls `onChange`.
 *
 * @param value    - Currently selected duration in days, or null for no expiry.
 * @param onChange - Called with the newly selected duration.
 */
export const ExpiryOpts: React.FC<{ value: number | null; onChange: (v: number | null) => void }> = ({ value, onChange }) => (
	<div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
		{EXPIRY_OPTS.map(({ label, days }) => (
			<div
				key={label}
				onClick={() => onChange(days)}
				style={{
					padding: '4px 10px',
					border: `1px solid ${value === days ? 'var(--rr-brand)' : 'var(--rr-border)'}`,
					borderRadius: 5,
					fontSize: 11,
					fontWeight: 500,
					cursor: 'pointer',
					color: value === days ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
					background: value === days ? 'var(--rr-bg-list-active)' : 'var(--rr-bg-surface-alt)',
					transition: 'border-color 0.12s, color 0.12s',
				}}
			>
				{label}
			</div>
		))}
	</div>
);
