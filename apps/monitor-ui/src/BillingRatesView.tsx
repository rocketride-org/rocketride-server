// MIT License
// Copyright (c) 2026 Aparavi Software AG

// =============================================================================
// BILLING RATES VIEW — CRUD for metrics_conversions table (sys.admin)
// =============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { getClient } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';

// =============================================================================
// TYPES
// =============================================================================

interface BillingRate {
	metric_key: string;
	tokens_per_unit: number;
	unit: string;
	description: string;
	updated_at: string | null;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		...commonStyles.columnFill,
		padding: 20,
		gap: 20,
		overflow: 'auto',
	} as CSSProperties,

	title: {
		fontSize: 18,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	subtitle: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginTop: -12,
	} as CSSProperties,

	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 13,
	} as CSSProperties,

	actions: {
		display: 'flex',
		gap: 8,
	} as CSSProperties,

	input: {
		padding: '4px 8px',
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		background: 'var(--rr-bg-surface)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	inputWide: {
		padding: '4px 8px',
		fontSize: 12,
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		background: 'var(--rr-bg-surface)',
		color: 'var(--rr-text-primary)',
		width: '100%',
	} as CSSProperties,

	addRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
		padding: '12px 0',
		borderTop: '1px solid var(--rr-border)',
		marginTop: 8,
	} as CSSProperties,

	error: {
		color: 'var(--rr-color-error)',
		fontSize: 12,
		padding: '8px 0',
	} as CSSProperties,

	mono: {
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * CRUD interface for the metrics_conversions table.
 *
 * Shows all billing rates in a table with inline editing.
 * Requires sys.admin privilege — non-admins see a permission error.
 */
const BillingRatesView: React.FC = () => {
	const [rates, setRates] = useState<BillingRate[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [editValue, setEditValue] = useState<string>('');

	// New rate form state
	const [newKey, setNewKey] = useState('');
	const [newRate, setNewRate] = useState('0');
	const [newUnit, setNewUnit] = useState('');
	const [newDesc, setNewDesc] = useState('');

	// =========================================================================
	// FETCH
	// =========================================================================

	const fetchRates = useCallback(async () => {
		const client = getClient();
		if (!client) return;
		try {
			const result = await client.getBillingRates();
			setRates(result.rates);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		fetchRates();
	}, [fetchRates]);

	// =========================================================================
	// UPDATE
	// =========================================================================

	const handleSave = useCallback(async (metric_key: string) => {
		const client = getClient();
		if (!client) return;
		try {
			const val = parseFloat(editValue);
			if (isNaN(val) || val < 0) {
				setError('Rate must be a non-negative number');
				return;
			}
			await client.updateBillingRate({ metric_key, tokens_per_unit: val });
			setEditing(null);
			await fetchRates();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [editValue, fetchRates]);

	// =========================================================================
	// CREATE
	// =========================================================================

	const handleCreate = useCallback(async () => {
		const client = getClient();
		if (!client || !newKey || !newUnit) return;
		try {
			const val = parseFloat(newRate);
			if (isNaN(val) || val < 0) {
				setError('Rate must be a non-negative number');
				return;
			}
			await client.createBillingRate({
				metric_key: newKey,
				tokens_per_unit: val,
				unit: newUnit,
				description: newDesc,
			});
			setNewKey('');
			setNewRate('0');
			setNewUnit('');
			setNewDesc('');
			await fetchRates();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [newKey, newRate, newUnit, newDesc, fetchRates]);

	// =========================================================================
	// DELETE
	// =========================================================================

	const handleDelete = useCallback(async (metric_key: string) => {
		const client = getClient();
		if (!client) return;
		if (!window.confirm(`Delete billing rate "${metric_key}"?`)) return;
		try {
			await client.deleteBillingRate(metric_key);
			await fetchRates();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [fetchRates]);

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={styles.container}>
			<div style={styles.title}>Billing Rates</div>
			<div style={styles.subtitle}>
				Token conversion rates for pipeline billing. 1 token = $0.01. Requires sys.admin.
			</div>

			{error && <div style={styles.error}>{error}</div>}

			<table style={styles.table}>
				<thead>
					<tr>
						<th style={commonStyles.tableHeader}>Metric Key</th>
						<th style={{ ...commonStyles.tableHeader, textAlign: 'right' }}>Tokens/Unit</th>
						<th style={commonStyles.tableHeader}>Unit</th>
						<th style={commonStyles.tableHeader}>Description</th>
						<th style={{ ...commonStyles.tableHeader, textAlign: 'right' }}>$/Unit</th>
						<th style={commonStyles.tableHeader}>Actions</th>
					</tr>
				</thead>
				<tbody>
					{rates.map((r) => (
						<tr key={r.metric_key}>
							<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{r.metric_key}</td>
							<td style={{ ...commonStyles.tableCell, textAlign: 'right' }}>
								{editing === r.metric_key ? (
									<input
										type="number"
										step="0.001"
										min="0"
										style={{ ...styles.input, width: 80, textAlign: 'right' }}
										value={editValue}
										onChange={(e) => setEditValue(e.target.value)}
										onKeyDown={(e) => { if (e.key === 'Enter') handleSave(r.metric_key); if (e.key === 'Escape') setEditing(null); }}
										autoFocus
									/>
								) : (
									<span style={styles.mono}>{r.tokens_per_unit}</span>
								)}
							</td>
							<td style={commonStyles.tableCell}>{r.unit}</td>
							<td style={commonStyles.tableCell}>{r.description}</td>
							<td style={{ ...commonStyles.tableCell, textAlign: 'right', ...styles.mono }}>
								${(r.tokens_per_unit * 0.01).toFixed(6)}
							</td>
							<td style={commonStyles.tableCell}>
								<div style={styles.actions}>
									{editing === r.metric_key ? (
										<>
											<button style={commonStyles.buttonSmall} onClick={() => handleSave(r.metric_key)}>Save</button>
											<button style={commonStyles.buttonSmall} onClick={() => setEditing(null)}>Cancel</button>
										</>
									) : (
										<>
											<button style={commonStyles.buttonSmall} onClick={() => { setEditing(r.metric_key); setEditValue(String(r.tokens_per_unit)); }}>Edit</button>
											<button style={commonStyles.buttonSmall} onClick={() => handleDelete(r.metric_key)}>Delete</button>
										</>
									)}
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			{/* Add new rate */}
			<div style={styles.addRow}>
				<input style={{ ...styles.input, width: 140 }} placeholder="metric_key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
				<input style={{ ...styles.input, width: 80, textAlign: 'right' }} type="number" step="0.001" min="0" placeholder="rate" value={newRate} onChange={(e) => setNewRate(e.target.value)} />
				<input style={{ ...styles.input, width: 80 }} placeholder="unit" value={newUnit} onChange={(e) => setNewUnit(e.target.value)} />
				<input style={styles.inputWide} placeholder="description" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
				<button style={commonStyles.buttonSmall} onClick={handleCreate} disabled={!newKey || !newUnit}>Add</button>
			</div>
		</div>
	);
};

export default BillingRatesView;
