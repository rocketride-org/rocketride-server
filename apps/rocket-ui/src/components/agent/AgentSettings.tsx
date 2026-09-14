// Copyright (c) 2026 Aparavi Software AG. MIT License.

// =============================================================================
// AGENT SETTINGS — gear panel for bring-your-own-key/model (Phase 5, Task 6)
// =============================================================================
//
// One provider at a time: a top-level PROVIDER select, then that provider's
// masked API-key field, then that provider's MODEL select. Picking a different
// provider swaps the key field and the model list beneath it. This replaces the
// old wall of every-provider key rows + one giant grouped model dropdown.
//
// LOAD-BEARING SAVE CONTRACT — read before touching handleSave:
// the hook's `save(nextKeys, nextModel)` writes via `account.setEnv`, which
// REPLACES the whole user-variable dict but only for provider ids PRESENT in
// `nextKeys`, leaving a provider UNTOUCHED when its id is ABSENT. Because this
// panel edits ONE provider at a time, `nextKeys` carries at most the selected
// provider — and only when its key field was actually edited this session:
//   - key field untouched (masked "set" left alone) -> nextKeys is {} (no key change)
//   - key field edited, now non-empty                -> { [id]: value }
//   - key field edited, cleared back to empty         -> { [id]: '' } (deletes the stored key)
// Never include an untouched provider with '' — that would silently DELETE a
// real stored key the masked field only showed as "set".
// =============================================================================

import React, { useEffect, useState } from 'react';
import { Button, Modal, commonStyles } from 'shell';
import { useInferenceSettings } from '../../hooks/useInferenceSettings';

/** Props for {@link AgentSettings}. */
export interface AgentSettingsProps {
	/** Fired to dismiss the panel (Cancel, ✕, Escape, or a successful Save). */
	onClose: () => void;
}

/**
 * The gear panel: pick a provider, paste its key, pick one of its models — backed
 * by {@link useInferenceSettings}. Mount only while open (the caller conditionally
 * renders it) so its data load starts fresh each time.
 */
export function AgentSettings({ onClose }: AgentSettingsProps): React.JSX.Element {
	const { providers, models, currentModel, keyStatus, saving, save } = useInferenceSettings();

	const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(undefined);
	const [keyValue, setKeyValue] = useState('');
	// Whether the key field was edited this session — gates whether the key is written (see contract above).
	const [keyTouched, setKeyTouched] = useState(false);
	const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);

	/** The provider id half of a `<provider>/<model>` string, if it belongs to a known provider. */
	const providerOfModel = (model?: string): string | undefined => (model ? providers.find((p) => model.startsWith(`${p.id}/`))?.id : undefined);

	// Seed the selected provider + model once the catalog loads, without clobbering a
	// choice the user has already made. Default to the saved model's provider, else the
	// first provider that already has a key, else the first provider in the list.
	useEffect(() => {
		if (selectedProviderId !== undefined || providers.length === 0) return;
		const fromModel = providerOfModel(currentModel);
		const firstWithKey = providers.find((p) => keyStatus[p.id])?.id;
		const initial = fromModel ?? firstWithKey ?? providers[0]?.id;
		if (!initial) return;
		setSelectedProviderId(initial);
		if (fromModel === initial) setSelectedModel(currentModel);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [providers, currentModel, keyStatus]);

	const provider = providers.find((p) => p.id === selectedProviderId);
	const providerModels = (selectedProviderId && models[selectedProviderId]) || [];
	const keyIsSet = selectedProviderId ? Boolean(keyStatus[selectedProviderId]) : false;

	const changeProvider = (id: string): void => {
		setSelectedProviderId(id);
		// Fresh key draft per provider — never carry one provider's typed key to another.
		setKeyValue('');
		setKeyTouched(false);
		// Keep the saved model only if it belongs to the newly-selected provider.
		setSelectedModel(providerOfModel(currentModel) === id ? currentModel : undefined);
		setError(null);
	};

	const handleSave = async (): Promise<void> => {
		setError(null);
		if (!selectedProviderId) return;
		// Only the selected provider's key, and only if edited this session (see contract above).
		const nextKeys: Record<string, string | undefined> = keyTouched ? { [selectedProviderId]: keyValue } : {};
		try {
			await save(nextKeys, selectedModel);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<Modal
			title="Agent inference settings"
			onClose={onClose}
			width={460}
			footer={
				<>
					<Button variant="ghost" small disabled={saving} onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" small disabled={saving} onClick={() => void handleSave()}>
						{saving ? 'Saving…' : 'Save'}
					</Button>
				</>
			}
		>
			{error && <div style={{ color: 'var(--rr-color-error)', fontSize: 12, marginBottom: 10 }}>Save failed: {error}</div>}

			{providers.length === 0 ? (
				<div style={commonStyles.textMuted}>Loading providers…</div>
			) : (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
					{/* 1 — Provider */}
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						<label htmlFor="agent-provider-select" style={commonStyles.textMuted}>
							Provider
						</label>
						<select id="agent-provider-select" disabled={saving} value={selectedProviderId ?? ''} onChange={(e) => changeProvider(e.target.value)} style={commonStyles.inputField}>
							{providers.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label}
									{keyStatus[p.id] ? ' ✓' : ''}
								</option>
							))}
						</select>
					</div>

					{provider && (
						<>
							{/* 2 — API key for the selected provider */}
							<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
								<label htmlFor="agent-key-input" style={commonStyles.textMuted}>
									{provider.label} API key
								</label>
								<input
									id="agent-key-input"
									type="password"
									autoComplete="off"
									disabled={saving}
									value={keyValue}
									// NEVER pre-fill a real value — `keyStatus` is presence-only; the placeholder
									// is the ONLY signal of a stored key, and typing here always means "replace".
									placeholder={keyIsSet ? '•••• set — type to replace' : 'Paste key'}
									onChange={(e) => {
										setKeyValue(e.target.value);
										setKeyTouched(true);
									}}
									style={commonStyles.inputField}
								/>
								{!keyIsSet && !keyTouched && (
									<span style={{ ...commonStyles.textMuted, fontSize: 11 }}>Add your {provider.label} API key to use it. Reused from your `{provider.keyVar}` variable if already set.</span>
								)}
							</div>

							{/* 3 — Model for the selected provider */}
							<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
								<label htmlFor="agent-model-select" style={commonStyles.textMuted}>
									Model
								</label>
								{providerModels.length === 0 ? (
									<div style={{ ...commonStyles.textMuted, fontSize: 12 }}>No models available for {provider.label} yet.</div>
								) : (
									<select id="agent-model-select" disabled={saving} value={selectedModel ?? ''} onChange={(e) => setSelectedModel(e.target.value)} style={commonStyles.inputField}>
										<option value="" disabled>
											Select a model…
										</option>
										{providerModels.map((m) => (
											<option key={m.value} value={m.value}>
												{m.title}
											</option>
										))}
									</select>
								)}
							</div>
						</>
					)}
				</div>
			)}
		</Modal>
	);
}
