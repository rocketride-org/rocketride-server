// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// CONNECTION MANAGER VIEW — Landing page with connection tiles
// =============================================================================
//
// Displays a grid of saved connection tiles. Each tile shows the server name
// and host:port. Click to open in a new tab, hover for edit/delete buttons.
// A "+" button opens an inline form to add a new connection.
// =============================================================================

import React, { useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shared/themes/styles';
import { BxPlus, BxEditAlt, BxTrash, BxDesktop } from 'shell-ui';
import { useSavedConnections, addConnection, updateConnection, deleteConnection } from '../connections';
import type { SavedConnection } from '../connections';
import { getDocs } from '../docs';

// =============================================================================
// TYPES
// =============================================================================

/** Form state for the add/edit dialog. */
interface FormState {
	/** 'add' for new connection, or the connection id for editing. */
	mode: 'add' | string;
	/** Connection display name. */
	name: string;
	/** Server hostname or IP. */
	host: string;
	/** Server port. */
	port: string;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		...commonStyles.columnFill,
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		padding: '48px 32px',
		overflow: 'auto',
	} as CSSProperties,

	header: {
		display: 'flex',
		alignItems: 'center',
		gap: 16,
		marginBottom: 32,
	} as CSSProperties,

	title: {
		fontSize: 20,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		margin: 0,
	} as CSSProperties,

	addButton: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '6px 14px',
		borderRadius: 6,
		border: '1px solid var(--rr-brand)',
		background: 'transparent',
		color: 'var(--rr-brand)',
		fontSize: 13,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	grid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
		gap: 16,
		width: '100%',
		maxWidth: 960,
	} as CSSProperties,

	tile: {
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		padding: 20,
		borderRadius: 8,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-paper)',
		cursor: 'pointer',
		transition: 'border-color 0.15s, box-shadow 0.15s',
	} as CSSProperties,

	tileHover: {
		borderColor: 'var(--rr-brand)',
		boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
	} as CSSProperties,

	tileIcon: {
		color: 'var(--rr-brand)',
		marginBottom: 4,
	} as CSSProperties,

	tileName: {
		fontSize: 15,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	tileAddress: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-family-mono)',
	} as CSSProperties,

	tileActions: {
		position: 'absolute',
		top: 8,
		right: 8,
		display: 'flex',
		gap: 4,
	} as CSSProperties,

	iconButton: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 28,
		height: 28,
		borderRadius: 4,
		border: 'none',
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
		padding: 0,
	} as CSSProperties,

	formOverlay: {
		position: 'fixed',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: 'rgba(0,0,0,0.4)',
		zIndex: 1000,
	} as CSSProperties,

	formDialog: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
		padding: 24,
		borderRadius: 8,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-paper)',
		minWidth: 340,
		boxShadow: '0 8px 32px rgba(0,0,0,0.24)',
	} as CSSProperties,

	formTitle: {
		fontSize: 16,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		margin: 0,
	} as CSSProperties,

	formField: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
	} as CSSProperties,

	formLabel: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		fontWeight: 500,
	} as CSSProperties,

	formInput: {
		padding: '8px 10px',
		borderRadius: 4,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		fontSize: 13,
		fontFamily: 'var(--rr-font-family)',
		outline: 'none',
	} as CSSProperties,

	formButtons: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: 8,
		marginTop: 8,
	} as CSSProperties,

	buttonPrimary: {
		padding: '7px 16px',
		borderRadius: 6,
		border: 'none',
		background: 'var(--rr-brand)',
		color: '#fff',
		fontSize: 13,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	buttonSecondary: {
		padding: '7px 16px',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		background: 'transparent',
		color: 'var(--rr-text-primary)',
		fontSize: 13,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	empty: {
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		textAlign: 'center',
		padding: 32,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Connection manager landing page for the Profiler app.
 *
 * Displays saved connections as clickable tiles in a responsive grid.
 * Click a tile to open a profiler tab for that server.
 * Provides add/edit/delete functionality with an inline modal form.
 */
const ConnectionManagerView: React.FC = () => {
	const connections = useSavedConnections();
	const [form, setForm] = useState<FormState | null>(null);
	const [hoveredId, setHoveredId] = useState<string | null>(null);

	// =========================================================================
	// HANDLERS
	// =========================================================================

	/** Open a connection in a new document tab. */
	const handleConnect = useCallback((conn: SavedConnection) => {
		getDocs()?.openStaticDocument(`conn:${conn.id}`, conn.name, { host: conn.host, port: conn.port });
	}, []);

	/** Open the add form with default values. */
	const handleAdd = useCallback(() => {
		setForm({ mode: 'add', name: '', host: 'localhost', port: '5565' });
	}, []);

	/** Open the edit form for an existing connection. */
	const handleEdit = useCallback((e: React.MouseEvent, conn: SavedConnection) => {
		e.stopPropagation();
		setForm({ mode: conn.id, name: conn.name, host: conn.host, port: conn.port });
	}, []);

	/** Delete a connection with confirmation. */
	const handleDelete = useCallback((e: React.MouseEvent, conn: SavedConnection) => {
		e.stopPropagation();
		if (confirm(`Delete connection "${conn.name}"?`)) {
			deleteConnection(conn.id);
		}
	}, []);

	/** Save the form (add or update). */
	const handleSave = useCallback(() => {
		if (!form || !form.name.trim()) return;

		if (form.mode === 'add') {
			// Add new connection and immediately open it in a tab
			const id = addConnection({ name: form.name.trim(), host: form.host.trim(), port: form.port.trim() });
			getDocs()?.openStaticDocument(`conn:${id}`, form.name.trim(), { host: form.host.trim(), port: form.port.trim() });
		} else {
			// Update existing connection
			updateConnection(form.mode, { name: form.name.trim(), host: form.host.trim(), port: form.port.trim() });
		}
		setForm(null);
	}, [form]);

	/** Close the form without saving. */
	const handleCancel = useCallback(() => {
		setForm(null);
	}, []);

	/** Handle Enter/Escape keys in form inputs. */
	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter') handleSave();
		if (e.key === 'Escape') handleCancel();
	}, [handleSave, handleCancel]);

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={styles.container}>
			{/* Header with title and add button */}
			<div style={styles.header}>
				<h1 style={styles.title}>Profiler Connections</h1>
				<button style={styles.addButton} onClick={handleAdd}>
					<BxPlus size={16} /> New Connection
				</button>
			</div>

			{/* Connection tile grid */}
			{connections.length === 0 ? (
				<div style={styles.empty}>
					No saved connections. Click "New Connection" to add one.
				</div>
			) : (
				<div style={styles.grid}>
					{connections.map((conn) => {
						const isHovered = hoveredId === conn.id;
						return (
							<div
								key={conn.id}
								style={{ ...styles.tile, ...(isHovered ? styles.tileHover : {}) }}
								onClick={() => handleConnect(conn)}
								onMouseEnter={() => setHoveredId(conn.id)}
								onMouseLeave={() => setHoveredId(null)}
							>
								<div style={styles.tileIcon}>
									<BxDesktop size={28} />
								</div>
								<div style={styles.tileName}>{conn.name}</div>
								<div style={styles.tileAddress}>{conn.host}:{conn.port}</div>

								{/* Edit / Delete buttons visible on hover */}
								{isHovered && (
									<div style={styles.tileActions}>
										<button style={styles.iconButton} onClick={(e) => handleEdit(e, conn)} title="Edit">
											<BxEditAlt size={16} />
										</button>
										<button style={styles.iconButton} onClick={(e) => handleDelete(e, conn)} title="Delete">
											<BxTrash size={16} />
										</button>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{/* Add / Edit form modal */}
			{form && (
				<div style={styles.formOverlay} onClick={handleCancel}>
					<div style={styles.formDialog} onClick={(e) => e.stopPropagation()}>
						<h2 style={styles.formTitle}>
							{form.mode === 'add' ? 'New Connection' : 'Edit Connection'}
						</h2>

						<div style={styles.formField}>
							<label style={styles.formLabel}>Name</label>
							<input
								style={styles.formInput}
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
								onKeyDown={handleKeyDown}
								placeholder="e.g. Local Dev Server"
								autoFocus
							/>
						</div>

						<div style={styles.formField}>
							<label style={styles.formLabel}>Host</label>
							<input
								style={styles.formInput}
								value={form.host}
								onChange={(e) => setForm({ ...form, host: e.target.value })}
								onKeyDown={handleKeyDown}
								placeholder="localhost"
							/>
						</div>

						<div style={styles.formField}>
							<label style={styles.formLabel}>Port</label>
							<input
								style={styles.formInput}
								value={form.port}
								onChange={(e) => setForm({ ...form, port: e.target.value })}
								onKeyDown={handleKeyDown}
								placeholder="5565"
							/>
						</div>

						<div style={styles.formButtons}>
							<button style={styles.buttonSecondary} onClick={handleCancel}>Cancel</button>
							<button style={styles.buttonPrimary} onClick={handleSave}>
								{form.mode === 'add' ? 'Connect' : 'Save'}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};

export default ConnectionManagerView;
