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
// CONNECTION MANAGER VIEW — Landing page for test server connections
// =============================================================================
//
// Displays a grid of saved connection tiles. Each tile shows the server name
// and host:port. Click to open in a new tab, hover for edit/delete buttons.
// A "+" button opens an inline form to add a new connection.
// Ported from models-ui ConnectionManagerView.
// =============================================================================

import React, { useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shared/themes/styles';
import { BxPlus, BxEditAlt, BxTrash, BxDesktop } from 'shell-ui';
import {
	useSavedConnections, addConnection, updateConnection, deleteConnection,
	type SavedConnection,
} from '../connections';
import { getDocs } from '../docs';
import { openConnection } from '../TestApp';
import { DEFAULT_CONFIG } from '../session';

// =============================================================================
// TYPES
// =============================================================================

interface FormState {
	mode: 'add' | string;
	name: string;
	url: string;
	apiKey: string;
}

// =============================================================================
// STYLES
// =============================================================================

const s = {
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
		borderWidth: 1,
		borderStyle: 'solid',
		borderColor: 'var(--rr-border)',
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

const ALL_PHASES = ['sweep', 'stress', 'flood', 'pipe', 'chaos', 'hammer'];

const ConnectionManagerView: React.FC = () => {
	const connections = useSavedConnections();
	const [form, setForm] = useState<FormState | null>(null);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [showApiKey, setShowApiKey] = useState(false);
	const [apiKeyToggleHover, setApiKeyToggleHover] = useState(false);

	const handleConnect = useCallback((conn: SavedConnection) => {
		const docs = getDocs();
		if (docs) openConnection(docs, conn);
	}, []);

	const handleAdd = useCallback(() => {
		setForm({ mode: 'add', name: '', url: 'localhost:5565', apiKey: '' });
		setShowApiKey(false);
	}, []);

	const handleEdit = useCallback((e: React.MouseEvent, conn: SavedConnection) => {
		e.stopPropagation();
		setForm({ mode: conn.id, name: conn.name, url: conn.url, apiKey: conn.apiKey || '' });
		setShowApiKey(false);
	}, []);

	const handleDelete = useCallback((e: React.MouseEvent, conn: SavedConnection) => {
		e.stopPropagation();
		if (confirm(`Delete connection "${conn.name}"?`)) {
			deleteConnection(conn.id);
		}
	}, []);

	const handleSave = useCallback(() => {
		if (!form || !form.name.trim()) return;
		const docs = getDocs();

		if (form.mode === 'add') {
			const id = addConnection({
				name: form.name.trim(),
				url: form.url.trim(),
				apiKey: form.apiKey.trim(),
				config: { ...DEFAULT_CONFIG },
				selectedPhases: [...ALL_PHASES],
			});
			if (docs) {
				const conn: SavedConnection = {
					id,
					name: form.name.trim(),
					url: form.url.trim(),
					apiKey: form.apiKey.trim(),
					config: { ...DEFAULT_CONFIG },
					selectedPhases: [...ALL_PHASES],
				};
				openConnection(docs, conn);
			}
		} else {
			updateConnection(form.mode, {
				name: form.name.trim(),
				url: form.url.trim(),
				apiKey: form.apiKey.trim(),
			});
		}
		setForm(null);
	}, [form]);

	const handleCancel = useCallback(() => setForm(null), []);

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter') handleSave();
		if (e.key === 'Escape') handleCancel();
	}, [handleSave, handleCancel]);

	return (
		<div style={s.container}>
			<div style={s.header}>
				<h1 style={s.title}>Test Server Connections</h1>
				<button style={s.addButton} onClick={handleAdd}>
					<BxPlus size={16} /> New Connection
				</button>
			</div>

			{connections.length === 0 ? (
				<div style={s.empty}>
					No saved connections. Click "New Connection" to add one.
				</div>
			) : (
				<div style={s.grid}>
					{connections.map((conn) => {
						const isHovered = hoveredId === conn.id;
						return (
							<div
								key={conn.id}
								style={{ ...s.tile, ...(isHovered ? s.tileHover : {}) }}
								onClick={() => handleConnect(conn)}
								onMouseEnter={() => setHoveredId(conn.id)}
								onMouseLeave={() => setHoveredId(null)}
							>
								<div style={s.tileIcon}>
									<BxDesktop size={28} />
								</div>
								<div style={s.tileName}>{conn.name}</div>
								<div style={s.tileAddress}>{conn.url}</div>

								{isHovered && (
									<div style={s.tileActions}>
										<button style={s.iconButton} onClick={(e) => handleEdit(e, conn)} title="Edit connection">
											<BxEditAlt size={16} />
										</button>
										<button style={s.iconButton} onClick={(e) => handleDelete(e, conn)} title="Delete connection">
											<BxTrash size={16} />
										</button>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{form && (
				<div style={s.formOverlay} onClick={handleCancel}>
					<div style={s.formDialog} onClick={(e) => e.stopPropagation()}>
						<h2 style={s.formTitle}>
							{form.mode === 'add' ? 'New Connection' : 'Edit Connection'}
						</h2>

						<div style={s.formField}>
							<label style={s.formLabel}>Name</label>
							<input
								style={s.formInput}
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
								onKeyDown={handleKeyDown}
								placeholder="e.g. Local OSS Server"
								autoFocus
							/>
						</div>

						<div style={s.formField}>
							<label style={s.formLabel}>URL</label>
							<input
								style={s.formInput}
								value={form.url}
								onChange={(e) => setForm({ ...form, url: e.target.value })}
								onKeyDown={handleKeyDown}
								placeholder="localhost:5565"
							/>
						</div>

						<div style={s.formField}>
							<label style={s.formLabel}>API Key</label>
							<div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
								<input
									style={{ ...s.formInput, flex: 1 }}
									type={showApiKey ? 'text' : 'password'}
									value={form.apiKey}
									onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
									onKeyDown={handleKeyDown}
									placeholder="Optional"
								/>
								<button
									type="button"
									onClick={() => setShowApiKey(!showApiKey)}
									title={showApiKey ? 'Hide API key' : 'Show API key'}
									onMouseEnter={() => setApiKeyToggleHover(true)}
									onMouseLeave={() => setApiKeyToggleHover(false)}
									style={{
										...s.buttonSecondary,
										minWidth: 44,
										padding: '7px 10px',
										fontSize: 12,
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										transition: 'all 0.15s',
										...(apiKeyToggleHover ? { borderColor: 'var(--rr-brand)' } : {}),
									}}
								>
									{showApiKey ? 'Hide' : 'Show'}
								</button>
							</div>
						</div>

						<div style={s.formButtons}>
							<button style={s.buttonSecondary} onClick={handleCancel}>Cancel</button>
							<button style={s.buttonPrimary} onClick={handleSave}>
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
