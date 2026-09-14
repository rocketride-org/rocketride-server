// Copyright (c) 2026 Aparavi Software AG. MIT License.
import React, { useCallback, useState } from 'react';
import { ChatView, commonStyles } from 'shell';
import { useAgentSession } from '../../hooks/useAgentSession';
import { useInferenceSettings } from '../../hooks/useInferenceSettings';
import { PermissionPrompt } from './PermissionPrompt';
import { GatePrompt } from './GatePrompt';
import { SpendMeter } from './SpendMeter';
import { SavedPipeChip } from './SavedPipeChip';
import { AgentSettings } from './AgentSettings';

/** Props for {@link AgentSessionView}. */
export interface AgentSessionViewProps {
	/** The rocket-agent session id to attach to. */
	sessionId: string;
	/** Fires with the workspace-relative path on every agent file edit (Task 4.4 wires canvas sync here). */
	onFileChange?: (file: string) => void;
	/** Store-path form of the pipe open on the canvas, when there is one — forwarded to `useAgentSession` so the server can name it in the per-turn `<live-state>` block (Layer 2). */
	openDocUri?: string;
}

/** Status labels for non-active/idle states shown next to the save button. */
const STATUS_LABEL: Record<string, string> = {
	paused_auth: 'Re-authenticating…',
	workspace_full: 'Workspace full',
};

/**
 * The single chat surface every Rocket Agent entry point mounts — the
 * `agent:` document tab ({@link AgentTab}) and the canvas right rail
 * ({@link AgentPanel}), so every surface stays in lockstep by construction
 * as more are added.
 */
export function AgentSessionView({ sessionId, onFileChange, openDocUri }: AgentSessionViewProps): React.JSX.Element {
	const s = useAgentSession(sessionId, onFileChange, openDocUri);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [restarting, setRestarting] = useState(false);
	// Own, lightweight instance of the same hook the gear panel consumes — just
	// for the "no usable key" empty-state prompt below. `providers.length > 0`
	// guards the check until the catalog has actually loaded, so it never
	// flashes true before the first fetch resolves.
	const inference = useInferenceSettings();
	const noUsableKey = inference.providers.length > 0 && inference.providers.every((p) => !inference.keyStatus[p.id]);
	// Friendly label for the currently-chosen model ("OpenAI · GPT-5.4"), shown under the
	// spend meter so the active model is always visible. Falls back to the raw
	// `<provider>/<model>` string if the catalog hasn't loaded or doesn't list it.
	const currentModelLabel = (() => {
		const cm = inference.currentModel;
		if (!cm) return null;
		for (const p of inference.providers) {
			const opt = (inference.models[p.id] ?? []).find((m) => m.value === cm);
			if (opt) return `${p.label} · ${opt.title}`;
		}
		return cm;
	})();
	// The running opencode child is on `s.runningModel`; the user's chosen model is
	// `inference.currentModel`. When they diverge (a mid-session model change), offer a
	// restart that re-spawns with the new model and keeps the conversation.
	const modelChangePending = Boolean(s.connected && s.runningModel && inference.currentModel && s.runningModel !== inference.currentModel);

	const handleRestart = useCallback(async () => {
		// Quick confirm — a restart stops any in-flight turn, so it shouldn't be a surprise.
		if (!window.confirm('Restart this session with the newly-selected model? Your conversation is kept; a turn in progress will stop.')) return;
		setRestarting(true);
		setSaveError(null);
		try {
			await s.restart();
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setRestarting(false);
		}
	}, [s]);

	const handleSave = useCallback(async () => {
		setSaveError(null);
		try {
			const pipes = await s.save();
			// usePipelineTree + SidebarProvider.refresh listen for exactly this event shape (ProjectProvider.tsx:316/453).
			for (const p of pipes) window.dispatchEvent(new CustomEvent('project:saved', { detail: { projectId: p } }));
		} catch (err) {
			// Mirrors useAgentSession.send's error path (useAgentSession.ts:197):
			// surface the failure instead of an unhandled rejection + silent no-op.
			setSaveError(err instanceof Error ? err.message : String(err));
		}
	}, [s]);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', flexWrap: 'wrap' }}>
				<SpendMeter spend={s.spend} />
				{s.agentInfo && (
					<span style={commonStyles.textMuted} title={`agents loaded: ${s.agentInfo.agents.join(', ')}`}>
						{s.agentInfo.activeAgent}
						{!s.agentInfo.agents.includes(s.agentInfo.activeAgent) && <span style={{ color: 'var(--rr-color-error)' }}> ⚠ not loaded</span>}
						{s.agentInfo.engine && ` · ${s.agentInfo.engine} engine`}
					</span>
				)}
				<span style={{ flex: 1 }} />
				{s.status !== 'active' && s.status !== 'idle' && <span style={commonStyles.textMuted}>{STATUS_LABEL[s.status] ?? s.status}</span>}
				{/* Inference settings now live in the sidebar Agent panel (AgentSidebarSection) —
				    the chat header keeps only Save. The empty-state prompt below still opens the
				    same panel inline via `setSettingsOpen` for a first-run nudge. */}
				<button style={s.connected ? commonStyles.buttonSecondarySmall : { ...commonStyles.buttonSecondarySmall, ...commonStyles.buttonDisabled }} onClick={() => void handleSave()} disabled={!s.connected}>
					Save to project
				</button>
			</div>
			{currentModelLabel && (
				<div style={{ padding: '0 12px 4px', fontSize: 11 }}>
					<span style={commonStyles.textMuted}>Model: {currentModelLabel}</span>
				</div>
			)}
			{modelChangePending && (
				<div style={{ padding: '0 12px 6px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
					<span style={commonStyles.textMuted}>This session is still running its previous model.</span>
					<button style={restarting ? { ...commonStyles.buttonSecondarySmall, ...commonStyles.buttonDisabled } : commonStyles.buttonSecondarySmall} onClick={() => void handleRestart()} disabled={restarting}>
						{restarting ? 'Restarting…' : `Restart to apply ${currentModelLabel}`}
					</button>
				</div>
			)}
			{saveError && <div style={{ padding: '0 12px 4px', fontSize: 11, color: 'var(--rr-color-error)' }}>Save failed: {saveError}</div>}
			{noUsableKey && s.messages.length === 0 && (
				<div style={{ padding: '0 12px 4px', fontSize: 11 }}>
					<span style={commonStyles.textMuted}>No inference key configured — </span>
					<button
						style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: 11, color: 'var(--rr-brand)', cursor: 'pointer', textDecoration: 'underline' }}
						onClick={() => setSettingsOpen(true)}
					>
						open agent settings ⚙
					</button>
					<span style={commonStyles.textMuted}> to add one.</span>
				</div>
			)}
			{s.savedPipes.length > 0 && (
				<div style={{ display: 'flex', gap: 6, padding: '0 12px 4px', flexWrap: 'wrap' }}>
					{s.savedPipes.map((p) => (
						<SavedPipeChip key={p} pipePath={p} />
					))}
				</div>
			)}
			<div style={{ flex: 1, minHeight: 0 }}>
				<ChatView
					messages={s.messages}
					isTyping={s.isTyping}
					isConnected={s.connected}
					onSend={s.send}
					placeholder="Describe the pipeline you want, or ask about a running one…"
					emptyTitle="Rocket Agent"
					emptyDescription="The agent edits .pipe files in a private workspace and validates them against the engine."
					leadingInputSlot={
						s.isTyping || s.pendingPermission || s.pendingGate ? (
							<>
								{/* Stop sits to the LEFT of the composer text box (ChatInputField renders the slot
								    before the textarea) — halts a hung/runaway turn. Shown only while a turn is
								    in flight; a pending gate/permission ends the turn, so these rarely coexist. */}
								{s.isTyping && (
									<button style={commonStyles.buttonSecondarySmall} onClick={() => void s.stop()} title="Stop the agent's current turn">
										■ Stop
									</button>
								)}
								{s.pendingPermission && <PermissionPrompt ask={s.pendingPermission} onAnswer={s.answerPermission} />}
								{s.pendingGate && <GatePrompt ask={s.pendingGate} onAnswer={s.answerGate} />}
							</>
						) : undefined
					}
				/>
			</div>
			{settingsOpen && <AgentSettings onClose={() => setSettingsOpen(false)} />}
		</div>
	);
}
