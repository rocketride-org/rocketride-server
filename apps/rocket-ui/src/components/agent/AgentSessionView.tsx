// Copyright (c) 2026 Aparavi Software AG. MIT License.
import React, { useCallback, useState } from 'react';
import { ChatView, commonStyles } from 'shell';
import { useAgentSession } from '../../hooks/useAgentSession';
import { PermissionPrompt } from './PermissionPrompt';
import { SpendMeter } from './SpendMeter';
import { SavedPipeChip } from './SavedPipeChip';

/** Props for {@link AgentSessionView}. */
export interface AgentSessionViewProps {
	/** The rocket-agent session id to attach to. */
	sessionId: string;
	/** Fires with the workspace-relative path on every agent file edit (Task 4.4 wires canvas sync here). */
	onFileChange?: (file: string) => void;
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
export function AgentSessionView({ sessionId, onFileChange }: AgentSessionViewProps): React.JSX.Element {
	const s = useAgentSession(sessionId, onFileChange);
	const [saveError, setSaveError] = useState<string | null>(null);

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
				<button style={s.connected ? commonStyles.buttonSecondarySmall : { ...commonStyles.buttonSecondarySmall, ...commonStyles.buttonDisabled }} onClick={() => void handleSave()} disabled={!s.connected}>
					Save to project
				</button>
			</div>
			{saveError && <div style={{ padding: '0 12px 4px', fontSize: 11, color: 'var(--rr-color-error)' }}>Save failed: {saveError}</div>}
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
					leadingInputSlot={s.pendingPermission ? <PermissionPrompt ask={s.pendingPermission} onAnswer={s.answerPermission} /> : undefined}
				/>
			</div>
		</div>
	);
}
