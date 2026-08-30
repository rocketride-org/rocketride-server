// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionManagerView — the shared Archetype-C "connections landing" shell.
 *
 * Three apps (models-ui, test-ui, profiler-ui) rendered a near-identical page:
 * a ContentHeader ("… Connections" + a "+ New Connection" secondary action), a
 * responsive grid of stock {@link ConnectionCard}s (with a trailing dashed add
 * tile), hover edit / delete on each card, and a short add/edit form dialog.
 * They diverged only in the connection data model, the form fields, and what
 * "open" does. This component owns the shared shell and is parameterised over
 * the connection type `T`; each app supplies its fields, card mapping, and the
 * create / update / open / delete behaviour via props.
 *
 * The add/edit dialog is the stock {@link Modal}: its footer carries Cancel, so
 * under the refined popup policy (2026-07-08) it shows no redundant top-right ✕,
 * the backdrop is inert, and Escape closes it.
 */

import React, { CSSProperties, ReactNode, useState } from 'react';
import { commonStyles } from '../../themes/styles';
import { Button } from '../button/Button';
import { InputField } from '../input-field/InputField';
import { ContentHeader } from '../content-header/ContentHeader';
import { EmptyState } from '../empty-state/EmptyState';
import { ConnectionCard, ConnectionCardAdd } from '../connection-card/ConnectionCard';
import { Modal } from '../modal/Modal';
import { BxDesktop } from '../BoxIcon';
import type { StatusVariant } from '../status-badge/StatusBadge';

// =============================================================================
// TYPES
// =============================================================================

/** Display props derived from a connection for its {@link ConnectionCard}. */
export interface IConnectionCardDisplay {
	/** Card title (connection name). */
	name: string;
	/** Card sub-line (address / endpoint, e.g. "localhost:5590"). */
	address: string;
	/** StatusBadge variant for the connection's state. */
	status: Extract<StatusVariant, 'success' | 'muted' | 'error'>;
	/** StatusBadge label, e.g. "Connected" / "Disconnected". */
	statusLabel: string;
	/** When true, the card carries the brand border and brand icon colour. */
	connected?: boolean;
}

/** One field in the add/edit form. */
export interface IConnectionFormField {
	/** Key into the form's value map (also the persisted field name). */
	key: string;
	/** Field label shown above the input. */
	label: string;
	/** Placeholder text for the input. */
	placeholder?: string;
	/** Render as a password input with a Show/Hide reveal toggle. */
	secret?: boolean;
	/** The form cannot be saved while this field is empty (after trim). */
	required?: boolean;
	/** Autofocus this field when the dialog opens. */
	autoFocus?: boolean;
}

/** Props for {@link ConnectionManagerView}. */
export interface IConnectionManagerViewProps<T extends { id: string }> {
	/** Page title, e.g. "Model Server Connections". */
	title: string;
	/** One-line subtitle beneath the title. */
	subtitle: string;
	/** Empty-state heading. Defaults to "No connections yet". */
	emptyTitle?: string;
	/** Empty-state supporting line. */
	emptyDescription: string;
	/** The saved connections to list. */
	connections: T[];
	/** Derive a card's display props from a connection. */
	card: (conn: T) => IConnectionCardDisplay;
	/** The add/edit form fields (rendered in order). */
	fields: IConnectionFormField[];
	/** Seed values for a new (add) form, keyed by field key. */
	newValues: Record<string, string>;
	/** Extract an existing connection's field values for the edit form. */
	editValues: (conn: T) => Record<string, string>;
	/** Persist a new connection from the (raw) field values; may open it. */
	onCreate: (values: Record<string, string>) => void;
	/** Persist edits to an existing connection from the (raw) field values. */
	onUpdate: (conn: T, values: Record<string, string>) => void;
	/** Open a saved connection (app-specific — tab, doc, session, …). */
	onOpen: (conn: T) => void;
	/** Delete a saved connection (the app owns any confirmation prompt). */
	onDelete: (conn: T) => void;
	/** Icon renderer for cards (30px) and the empty state (40px). Defaults to BxDesktop. */
	icon?: (size: number) => ReactNode;
}

/** Internal add/edit dialog state — `conn` null means "add", otherwise "edit". */
interface IFormState<T> {
	/** The connection being edited, or null while adding a new one. */
	conn: T | null;
	/** Current field values keyed by field key. */
	values: Record<string, string>;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Column-filling root: header pinned, content scrolls.
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// Content region beneath the ContentHeader (style-guide page grammar:
	// 20px below the header, 24px on the remaining sides).
	content: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: '20px 24px 24px',
	} as CSSProperties,

	// Connection card grid — auto-fill, 230px minimum, 16px gaps.
	grid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
		gap: 16,
	} as CSSProperties,

	// Single stacked form field (label above input).
	formField: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
	} as CSSProperties,

	// Second-and-later fields carry a 12px gap from the field above.
	formFieldSpaced: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
		marginTop: 12,
	} as CSSProperties,

	formLabel: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		fontWeight: 500,
	} as CSSProperties,

	// Secret-field row: input + reveal toggle.
	secretRow: {
		display: 'flex',
		gap: 6,
		alignItems: 'stretch',
	} as CSSProperties,

	// Secret input flexes to fill the row beside the reveal toggle.
	secretInput: {
		flex: 1,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the shared connections landing page (Archetype C).
 *
 * @param props - {@link IConnectionManagerViewProps}.
 * @returns The connections landing element.
 */
export function ConnectionManagerView<T extends { id: string }>({ title, subtitle, emptyTitle = 'No connections yet', emptyDescription, connections, card, fields, newValues, editValues, onCreate, onUpdate, onOpen, onDelete, icon }: IConnectionManagerViewProps<T>): React.ReactElement {
	// Add/edit dialog state and per-field reveal state (secret inputs).
	const [form, setForm] = useState<IFormState<T> | null>(null);
	const [revealed, setRevealed] = useState<Record<string, boolean>>({});

	// Icon renderer — apps may override; defaults to the desktop/server glyph.
	const renderIcon = icon ?? ((size: number) => <BxDesktop size={size} />);

	// =========================================================================
	// HANDLERS
	// =========================================================================

	/** Open the add form seeded with the app's default values. */
	const openAdd = (): void => {
		setForm({ conn: null, values: { ...newValues } });
		setRevealed({});
	};

	/** Open the edit form seeded from an existing connection. */
	const openEdit = (conn: T): void => {
		setForm({ conn, values: editValues(conn) });
		setRevealed({});
	};

	/** Close the form without saving. */
	const closeForm = (): void => setForm(null);

	/** Update a single field's value in the open form. */
	const setFieldValue = (key: string, value: string): void => {
		setForm((prev) => (prev ? { ...prev, values: { ...prev.values, [key]: value } } : prev));
	};

	/** Save the form — creates when adding, updates when editing. */
	const save = (): void => {
		if (!form) return;
		// Guard: required fields must be non-empty (after trim). Matches the
		// original per-app name-required guard; the primary button stays enabled.
		for (const f of fields) {
			if (f.required && !(form.values[f.key] ?? '').trim()) return;
		}
		if (form.conn == null) onCreate(form.values);
		else onUpdate(form.conn, form.values);
		setForm(null);
	};

	/** Submit on Enter while a form field is focused (Escape is handled by Modal). */
	const handleFieldKeyDown = (e: React.KeyboardEvent): void => {
		if (e.key === 'Enter') save();
	};

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={styles.root}>
			<ContentHeader
				title={title}
				subtitle={subtitle}
				actions={
					<Button variant="secondary" onClick={openAdd}>
						+ New Connection
					</Button>
				}
			/>

			<div style={styles.content}>
				{connections.length === 0 ? (
					// Empty state — no saved connections yet.
					<EmptyState
						icon={renderIcon(40)}
						title={emptyTitle}
						description={emptyDescription}
						action={
							<Button variant="secondary" onClick={openAdd}>
								+ New Connection
							</Button>
						}
					/>
				) : (
					<div style={styles.grid}>
						{connections.map((conn) => {
							// Per-connection card display props from the app's mapper.
							const display = card(conn);
							return <ConnectionCard key={conn.id} icon={renderIcon(30)} name={display.name} address={display.address} status={display.status} statusLabel={display.statusLabel} connected={display.connected} onEdit={() => openEdit(conn)} onDelete={() => onDelete(conn)} onClick={() => onOpen(conn)} />;
						})}
						{/* Dashed "add a connection" tile terminates the grid. */}
						<ConnectionCardAdd label="New Connection" onClick={openAdd} />
					</div>
				)}
			</div>

			{/* Add / Edit form dialog (short form) — stock Modal (footer Cancel, no ✕). */}
			{form && (
				<Modal
					title={form.conn == null ? 'New Connection' : 'Edit Connection'}
					onClose={closeForm}
					footer={
						<>
							<Button variant="ghost" onClick={closeForm}>
								Cancel
							</Button>
							<Button variant="primary" onClick={save}>
								{form.conn == null ? 'Connect' : 'Save'}
							</Button>
						</>
					}
				>
					{fields.map((f, i) => (
						<div key={f.key} style={i === 0 ? styles.formField : styles.formFieldSpaced}>
							<label style={styles.formLabel}>{f.label}</label>
							{f.secret ? (
								// Secret field: masked input with a Show/Hide reveal toggle.
								<div style={styles.secretRow}>
									<InputField style={styles.secretInput} type={revealed[f.key] ? 'text' : 'password'} value={form.values[f.key] ?? ''} onChange={(e) => setFieldValue(f.key, e.target.value)} onKeyDown={handleFieldKeyDown} placeholder={f.placeholder} autoFocus={f.autoFocus} />
									<Button variant="ghost" onClick={() => setRevealed({ ...revealed, [f.key]: !revealed[f.key] })}>
										{revealed[f.key] ? 'Hide' : 'Show'}
									</Button>
								</div>
							) : (
								<InputField value={form.values[f.key] ?? ''} onChange={(e) => setFieldValue(f.key, e.target.value)} onKeyDown={handleFieldKeyDown} placeholder={f.placeholder} autoFocus={f.autoFocus} />
							)}
						</div>
					))}
				</Modal>
			)}
		</div>
	);
}
