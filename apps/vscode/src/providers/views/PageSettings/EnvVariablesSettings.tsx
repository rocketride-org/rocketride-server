// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import React, { useState, CSSProperties } from 'react';
import { SettingsData, settingsStyles as S } from './PageSettings';

// ============================================================================
// TYPES
// ============================================================================

interface EnvVariablesSettingsProps {
	settings: SettingsData;
	onEnvVarAdd: (key: string, value: string) => void;
	onEnvVarUpdate: (key: string, value: string) => void;
	onEnvVarDelete: (key: string) => void;
}

// ============================================================================
// STYLES
// ============================================================================

const styles = {
	envVariableRow: {
		display: 'grid',
		gridTemplateColumns: '200px 1fr auto',
		gap: 8,
		padding: 12,
		alignItems: 'center',
	} as CSSProperties,
	envVariableName: {
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: 'var(--vscode-editor-font-size)',
		fontWeight: 500,
		color: 'var(--rr-color-success)',
	} as CSSProperties,
	envVariableValueContainer: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,
	envVariableValueCode: {
		flex: 1,
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: 'var(--vscode-editor-font-size)',
		padding: '4px 8px',
		backgroundColor: 'var(--vscode-textCodeBlock-background)',
		borderRadius: 3,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,
	envVariableActions: {
		display: 'flex',
		gap: 4,
		justifyContent: 'flex-end',
	} as CSSProperties,
};

// ============================================================================
// COMPONENT
// ============================================================================

export const EnvVariablesSettings: React.FC<EnvVariablesSettingsProps> = ({ settings, onEnvVarAdd, onEnvVarUpdate, onEnvVarDelete }) => {
	const [newKey, setNewKey] = useState('');
	const [newValue, setNewValue] = useState('');
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [editingValue, setEditingValue] = useState('');
	const [showValues, setShowValues] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [deleteConfirmKey, setDeleteConfirmKey] = useState<string | null>(null);
	const [dangerHover, setDangerHover] = useState(false);

	// Get env vars from settings
	const envVars: Record<string, string> = settings.envVars || {};
	const allEnvVars: [string, string][] = Object.entries(envVars) as [string, string][];

	// ========================================================================
	// EVENT HANDLERS
	// ========================================================================

	const handleAddVariable = () => {
		setError(null);

		// Validation
		if (!newKey.trim()) {
			setError('Variable name cannot be empty');
			return;
		}

		if (newKey.trim() in envVars) {
			setError('Variable already exists. Use edit to update it.');
			return;
		}

		// Add the variable
		onEnvVarAdd(newKey.trim(), newValue);

		// Clear form
		setNewKey('');
		setNewValue('');
	};

	const startEdit = (key: string, value: string) => {
		setEditingKey(key);
		setEditingValue(value);
		setError(null);
	};

	const cancelEdit = () => {
		setEditingKey(null);
		setEditingValue('');
		setError(null);
	};

	const saveEdit = () => {
		if (editingKey) {
			onEnvVarUpdate(editingKey, editingValue);
			setEditingKey(null);
			setEditingValue('');
			setError(null);
		}
	};

	const handleDelete = (key: string) => {
		setDeleteConfirmKey(key);
	};

	const confirmDelete = () => {
		if (deleteConfirmKey) {
			onEnvVarDelete(deleteConfirmKey);
			// If we were editing this key, cancel the edit
			if (editingKey === deleteConfirmKey) {
				cancelEdit();
			}
			setDeleteConfirmKey(null);
		}
	};

	const cancelDelete = () => {
		setDeleteConfirmKey(null);
	};

	const toggleValueVisibility = (key: string) => {
		const newShowValues = new Set(showValues);
		if (newShowValues.has(key)) {
			newShowValues.delete(key);
		} else {
			newShowValues.add(key);
		}
		setShowValues(newShowValues);
	};

	const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			action();
		} else if (e.key === 'Escape' && editingKey) {
			e.preventDefault();
			cancelEdit();
		}
	};

	// ========================================================================
	// RENDER
	// ========================================================================

	return (
		<div style={S.card} id="envVariablesSection">
			<div style={S.cardHeader}>Environment Variables</div>
			<div style={S.cardBody}>
				<div style={S.sectionDescription}>Manage environment variables for your .env file. Only variables prefixed with ROCKETRIDE_ can be used in pipeline configurations using the $&#123;ROCKETRIDE_VARIABLE_NAME&#125; syntax.</div>

				{error && (
					<div
						style={{
							marginBottom: 12,
							padding: '8px 12px',
							backgroundColor: 'var(--vscode-inputValidation-errorBackground)',
							border: '1px solid var(--vscode-inputValidation-errorBorder)',
							borderRadius: 3,
						}}
					>
						{error}
					</div>
				)}

				{/* Delete Confirmation */}
				{deleteConfirmKey && (
					<div
						style={{
							marginBottom: 16,
							padding: 12,
							backgroundColor: 'var(--vscode-inputValidation-warningBackground)',
							border: '1px solid var(--vscode-inputValidation-warningBorder)',
							borderRadius: 4,
						}}
					>
						<div style={{ marginBottom: 12, fontWeight: 500 }}>
							Are you sure you want to delete <strong>{deleteConfirmKey}</strong>?
						</div>
						<div style={{ display: 'flex', gap: 8 }}>
							<button
								onClick={confirmDelete}
								onMouseEnter={() => setDangerHover(true)}
								onMouseLeave={() => setDangerHover(false)}
								style={{
									padding: '6px 12px',
									backgroundColor: 'var(--rr-bg-button)',
									color: 'var(--rr-fg-button)',
									...(dangerHover
										? {
												backgroundColor: 'var(--vscode-button-hoverBackground)',
											}
										: {}),
								}}
							>
								Delete
							</button>
							<button
								onClick={cancelDelete}
								style={{
									padding: '6px 12px',
									backgroundColor: 'var(--vscode-button-secondaryBackground)',
									color: 'var(--vscode-button-secondaryForeground)',
								}}
							>
								Cancel
							</button>
						</div>
					</div>
				)}

				{/* Add New Variable Form */}
				<div
					style={{
						marginBottom: 20,
						backgroundColor: 'var(--rr-bg-default)',
						borderRadius: 4,
						border: '1px solid var(--vscode-panel-border)',
						padding: 12,
					}}
				>
					<label style={{ display: 'block', marginBottom: 12, fontWeight: 500 }}>Add New Variable</label>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
						<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
							<input type="text" placeholder="ROCKETRIDE_MY_VARIABLE" value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} onKeyDown={(e) => handleKeyDown(e, handleAddVariable)} style={{ width: '100%', boxSizing: 'border-box' }} />
							<div style={S.helpText}>Variable name</div>
						</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
							<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
								<input type="text" placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => handleKeyDown(e, handleAddVariable)} style={{ flex: 1 }} />
								<button onClick={handleAddVariable} disabled={!newKey.trim()} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
									Add Variable
								</button>
							</div>
							<div style={S.helpText}>Variable value</div>
						</div>
					</div>
				</div>

				{/* Existing Variables List */}
				{allEnvVars.length > 0 ? (
					<div style={{ marginTop: 16 }}>
						<label style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>Current Variables ({allEnvVars.length})</label>
						<div
							style={{
								border: '1px solid var(--vscode-panel-border)',
								borderRadius: 4,
								overflow: 'hidden',
							}}
						>
							{allEnvVars.map(([key, value], index) => {
								const isEditing = editingKey === key;
								const isVisible = showValues.has(key);
								const displayValue = isVisible ? value : '\u2022'.repeat(Math.min(value.length, 20));
								const isEven = index % 2 === 1;
								const isLast = index === allEnvVars.length - 1;

								return (
									<div
										key={key}
										style={{
											...styles.envVariableRow,
											...(isEven ? { backgroundColor: 'var(--rr-bg-default)' } : {}),
											...(!isLast ? { borderBottom: '1px solid var(--vscode-panel-border)' } : {}),
										}}
									>
										{/* Variable Name */}
										<div style={styles.envVariableName}>{key}</div>

										{/* Variable Value */}
										<div style={styles.envVariableValueContainer}>
											{isEditing ? (
												<input type="text" value={editingValue} onChange={(e) => setEditingValue(e.target.value)} onKeyDown={(e) => handleKeyDown(e, saveEdit)} autoFocus style={{ flex: 1, fontFamily: 'var(--vscode-editor-font-family)' }} />
											) : (
												<>
													<code style={styles.envVariableValueCode}>{displayValue}</code>
													<button type="button" onClick={() => toggleValueVisibility(key)} title={isVisible ? 'Hide value' : 'Show value'} style={{ padding: '2px 6px', minWidth: 30, fontSize: 12 }}>
														{isVisible ? '\u{1F648}' : '\u{1F50D}'}
													</button>
												</>
											)}
										</div>

										{/* Actions */}
										<div style={styles.envVariableActions}>
											{isEditing ? (
												<>
													<button onClick={saveEdit} title="Save changes" style={{ padding: '2px 8px', fontSize: 12 }}>
														Save
													</button>
													<button
														onClick={cancelEdit}
														title="Cancel editing"
														style={{
															padding: '2px 8px',
															fontSize: 12,
															backgroundColor: 'var(--vscode-button-secondaryBackground)',
															color: 'var(--vscode-button-secondaryForeground)',
														}}
													>
														Cancel
													</button>
												</>
											) : (
												<>
													<button onClick={() => startEdit(key, value)} title="Edit variable" style={{ padding: '2px 8px', fontSize: 12 }}>
														Edit
													</button>
													<button
														onClick={() => handleDelete(key)}
														title="Delete variable"
														style={{
															padding: '2px 8px',
															fontSize: 12,
															backgroundColor: 'var(--vscode-button-secondaryBackground)',
															color: 'var(--vscode-button-secondaryForeground)',
														}}
													>
														Delete
													</button>
												</>
											)}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				) : (
					<div
						style={{
							padding: 24,
							textAlign: 'center',
							color: 'var(--rr-text-secondary)',
							border: '1px dashed var(--vscode-panel-border)',
							borderRadius: 4,
							marginTop: 16,
						}}
					>
						No environment variables defined. Add one above to get started.
					</div>
				)}

				<div style={{ ...S.helpText, marginTop: 16 }}>
					<strong>Note:</strong> Variables are automatically saved to your workspace's .env file. Use them in pipeline configurations like: $&#123;ROCKETRIDE_MY_VARIABLE&#125;
				</div>
			</div>
		</div>
	);
};
