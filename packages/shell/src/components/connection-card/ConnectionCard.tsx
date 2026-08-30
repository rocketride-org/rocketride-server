// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionCard (+ ConnectionCardAdd) — the Archetype C source card.
 *
 * `ConnectionCard` shows a source's icon, name, and address with a stock
 * StatusBadge and hover-revealed edit / delete actions. A connected card carries
 * a brand border and a brand-tinted icon. `ConnectionCardAdd` is the paired
 * dashed "add a source" tile at the end of the grid.
 *
 * Composition: the status pill is the stock {@link StatusBadge}; the row actions
 * are the stock pencil / trash icons ({@link BxEditAlt} / {@link BxTrash}).
 */

import React, { CSSProperties, KeyboardEvent, MouseEvent, ReactNode, useState } from 'react';
import { StatusBadge } from '../status-badge/StatusBadge';
import type { StatusVariant } from '../status-badge/StatusBadge';
import { BxEditAlt, BxTrash } from '../BoxIcon';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ConnectionCard} component. */
export interface IConnectionCardProps {
	/** Optional source icon (rendered at 30px, inherits the card's icon colour). */
	icon?: ReactNode;
	/** Source name. */
	name: string;
	/** Source address / endpoint. */
	address: string;
	/** StatusBadge variant for the source's state. */
	status: Extract<StatusVariant, 'success' | 'muted' | 'error'>;
	/** StatusBadge label, e.g. "Connected" / "Disconnected". */
	statusLabel: string;
	/** When true, the card carries the brand border and brand icon colour. */
	connected?: boolean;
	/** Edit action — reveals the pencil icon on hover. */
	onEdit?: () => void;
	/** Delete action — reveals the trash icon on hover. */
	onDelete?: () => void;
	/** Select action for the whole card. */
	onClick?: () => void;
}

/** Props for the {@link ConnectionCardAdd} component. */
export interface IConnectionCardAddProps {
	/** Label beneath the plus glyph, e.g. "New Connection". */
	label: string;
	/** Fired when the add tile is activated. */
	onClick: () => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Card shell — brand border when connected, otherwise the standard border.
	card: (connected: boolean, clickable: boolean): CSSProperties => ({
		position: 'relative',
		padding: 18,
		borderRadius: 10,
		background: 'var(--rr-bg-paper)',
		border: `1px solid ${connected ? 'var(--rr-brand)' : 'var(--rr-border)'}`,
		cursor: clickable ? 'pointer' : 'default',
	}),

	// Icon slot — brand when connected, secondary otherwise.
	icon: (connected: boolean): CSSProperties => ({
		display: 'inline-flex',
		width: 30,
		height: 30,
		marginBottom: 14,
		color: connected ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
	}),

	// Absolute action cluster, revealed on hover.
	actions: (visible: boolean): CSSProperties => ({
		position: 'absolute',
		top: 14,
		right: 14,
		display: 'flex',
		gap: 10,
		color: 'var(--rr-text-secondary)',
		opacity: visible ? 1 : 0,
		transition: 'opacity 0.12s',
	}),

	actionButton: {
		display: 'inline-flex',
		cursor: 'pointer',
	} as CSSProperties,

	name: {
		fontSize: 15,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	address: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 5,
	} as CSSProperties,

	badge: {
		marginTop: 12,
	} as CSSProperties,

	// Add tile — dashed border, centred plus glyph + label.
	add: {
		position: 'relative',
		padding: 18,
		borderRadius: 10,
		border: '1px dashed var(--rr-border-hover)',
		background: 'var(--rr-bg-paper)',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		minHeight: 138,
		cursor: 'pointer',
	} as CSSProperties,

	addPlus: {
		fontSize: 24,
		color: 'var(--rr-text-disabled)',
		marginBottom: 6,
		lineHeight: 1,
	} as CSSProperties,

	addLabel: {
		fontSize: 13.5,
		fontWeight: 600,
	} as CSSProperties,
};

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders a connection / source card.
 *
 * @param props - {@link IConnectionCardProps}.
 * @returns The card element.
 */
export function ConnectionCard({ icon, name, address, status, statusLabel, connected = false, onEdit, onDelete, onClick }: IConnectionCardProps): React.ReactElement {
	// Hover state drives the visibility of the edit / delete actions.
	const [hovered, setHovered] = useState(false);

	// Fire an action without also triggering the card's own onClick.
	const runAction = (e: MouseEvent, action?: () => void): void => {
		e.stopPropagation();
		action?.();
	};

	// Keyboard twin of runAction: Enter / Space fire the action (and never the card).
	const runActionKey = (e: KeyboardEvent, action?: () => void): void => {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		e.stopPropagation();
		action?.();
	};

	return (
		<div
			style={styles.card(connected, onClick != null)}
			// The whole card is a select target only when onClick is set; then it is
			// focusable and Enter / Space activate it, like a button.
			role={onClick ? 'button' : undefined}
			tabIndex={onClick ? 0 : undefined}
			onClick={onClick}
			onKeyDown={
				onClick
					? (e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onClick();
							}
						}
					: undefined
			}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			// Focus mirrors hover so keyboard users see the revealed actions:
			// focus/blur bubble from the inner action buttons, giving the card
			// focus-within behaviour without a CSS class.
			onFocus={() => setHovered(true)}
			onBlur={(e) => {
				// Only clear when focus leaves the card entirely, not when it
				// moves between the card and its action buttons.
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(false);
			}}
		>
			{/* Hover-revealed edit / delete actions (also shown while focused). */}
			{(onEdit || onDelete) && (
				<div style={styles.actions(hovered)}>
					{onEdit && (
						<span role="button" aria-label="Edit" tabIndex={0} style={styles.actionButton} onClick={(e) => runAction(e, onEdit)} onKeyDown={(e) => runActionKey(e, onEdit)}>
							<BxEditAlt size={15} />
						</span>
					)}
					{onDelete && (
						<span role="button" aria-label="Delete" tabIndex={0} style={styles.actionButton} onClick={(e) => runAction(e, onDelete)} onKeyDown={(e) => runActionKey(e, onDelete)}>
							<BxTrash size={15} />
						</span>
					)}
				</div>
			)}
			{/* Optional source icon. */}
			{icon && <div style={styles.icon(connected)}>{icon}</div>}
			<div style={styles.name}>{name}</div>
			<div style={styles.address}>{address}</div>
			{/* Stock status pill. */}
			<div style={styles.badge}>
				<StatusBadge variant={status}>{statusLabel}</StatusBadge>
			</div>
		</div>
	);
}

/**
 * Renders the dashed "add a source" tile.
 *
 * @param props - {@link IConnectionCardAddProps}.
 * @returns The add-tile element.
 */
export function ConnectionCardAdd({ label, onClick }: IConnectionCardAddProps): React.ReactElement {
	return (
		<div
			role="button"
			aria-label={label}
			tabIndex={0}
			style={styles.add}
			onClick={onClick}
			onKeyDown={(e) => {
				// Enter / Space activate the add tile, matching native button semantics.
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onClick();
				}
			}}
		>
			<div style={styles.addPlus}>+</div>
			<div style={styles.addLabel}>{label}</div>
		</div>
	);
}
