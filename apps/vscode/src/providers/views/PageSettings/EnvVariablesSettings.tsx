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

import React, { useState } from 'react';
import { SettingsData } from './PageSettings';

interface EnvVariablesSettingsProps {
	settings: SettingsData;
	onEnvVarAdd: (key: string, value: string) => void;
	onEnvVarUpdate: (key: string, value: string) => void;
	onEnvVarDelete: (key: string) => void;
}

export const EnvVariablesSettings: React.FC<EnvVariablesSettingsProps> = ({
	settings,
	onEnvVarAdd,
	onEnvVarUpdate,
	onEnvVarDelete
}) => {
	const [newKey, setNewKey] = useState('');
	const [newValue, setNewValue] = useState('');
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [editingValue, setEditingValue] = useState('');
	const [showValues, setShowValues] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [deleteConfirmKey, setDeleteConfirmKey] = useState<string | null>(null);

	// Get env vars from settings
	const envVars: Record<string, string> = settings.envVars || {};
	const allEnvVars: [string, string][] = Object.entries(envVars) as [string, string][];

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

	return (
		<div className="section" id="envVariablesSection">
			<div className="section-title">Environment Variables</div>
			<div className="section-description">
				Manage environment variables for your .env file. 
				Only variables prefixed with ROCKETRIDE_ can be used in pipeline configurations using the $&#123;ROCKETRIDE_VARIABLE_NAME&#125; syntax.
			</div>

		{error && (
			<div className="env-error-message">
				{error}
			</div>
		)}

		{/* Delete Confirmation */}
		{deleteConfirmKey && (
			<div className="env-delete-confirm">
				<div className="env-delete-confirm-message">
					Are you sure you want to delete <strong>{deleteConfirmKey}</strong>?
				</div>
				<div className="env-delete-confirm-buttons">
					<button onClick={confirmDelete} className="danger">
						Delete
					</button>
					<button onClick={cancelDelete} className="secondary">
						Cancel
					</button>
				</div>
			</div>
		)}

		{/* Add New Variable Form */}
			<div className="env-add-form">
				<label>Add New Variable</label>
				<div className="env-add-form-content">
					<div className="env-add-form-row">
						<input
							type="text"
							placeholder="ROCKETRIDE_MY_VARIABLE"
							value={newKey}
							onChange={(e) => setNewKey(e.target.value.toUpperCase())}
							onKeyDown={(e) => handleKeyDown(e, handleAddVariable)}
						/>
						<div className="help-text">Variable name</div>
					</div>
					<div className="env-add-form-row">
						<div className="env-add-form-value-row">
							<input
								type="text"
								placeholder="value"
								value={newValue}
								onChange={(e) => setNewValue(e.target.value)}
								onKeyDown={(e) => handleKeyDown(e, handleAddVariable)}
							/>
							<button 
								onClick={handleAddVariable}
								disabled={!newKey.trim()}
							>
								Add Variable
							</button>
						</div>
						<div className="help-text">Variable value</div>
					</div>
				</div>
			</div>

			{/* Existing Variables List */}
			{allEnvVars.length > 0 ? (
				<div className="env-variables-list-container">
					<label className="env-variables-section-label">
						Current Variables ({allEnvVars.length})
					</label>
					<div className="env-variables-list">
						{allEnvVars.map(([key, value]) => {
							const isEditing = editingKey === key;
							const isVisible = showValues.has(key);
							const displayValue = isVisible ? value : '•'.repeat(Math.min(value.length, 20));

							return (
								<div key={key} className="env-variable-row">
									{/* Variable Name */}
									<div className="env-variable-name">
										{key}
									</div>

									{/* Variable Value */}
									<div className="env-variable-value-container">
										{isEditing ? (
											<input
												type="text"
												value={editingValue}
												onChange={(e) => setEditingValue(e.target.value)}
												onKeyDown={(e) => handleKeyDown(e, saveEdit)}
												autoFocus
											/>
										) : (
											<>
												<code className="env-variable-value-code">
													{displayValue}
												</code>
												<button
													type="button"
													className="small env-variable-value-toggle"
													onClick={() => toggleValueVisibility(key)}
													title={isVisible ? 'Hide value' : 'Show value'}
												>
													{isVisible ? '🙈' : '👁'}
												</button>
											</>
										)}
									</div>

									{/* Actions */}
									<div className="env-variable-actions">
										{isEditing ? (
											<>
												<button
													className="small"
													onClick={saveEdit}
													title="Save changes"
												>
													Save
												</button>
												<button
													className="small secondary"
													onClick={cancelEdit}
													title="Cancel editing"
												>
													Cancel
												</button>
											</>
										) : (
											<>
												<button
													className="small"
													onClick={() => startEdit(key, value)}
													title="Edit variable"
												>
													Edit
												</button>
												<button
													className="small secondary"
													onClick={() => handleDelete(key)}
													title="Delete variable"
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
				<div className="env-empty-state">
					No environment variables defined. Add one above to get started.
				</div>
			)}

			<div className="help-text env-note">
				<strong>Note:</strong> Variables are automatically saved to your workspace's .env file. 
				Use them in pipeline configurations like: $&#123;ROCKETRIDE_MY_VARIABLE&#125;
			</div>
		</div>
	);
};

