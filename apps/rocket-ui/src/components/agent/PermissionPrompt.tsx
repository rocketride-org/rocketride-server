// Copyright (c) 2026 Aparavi Software AG. MIT License.
import React, { useState } from 'react';
import type { OcPermissionAsk } from '../../services/agentTypes';

/** Props for {@link PermissionPrompt}. */
export interface PermissionPromptProps {
	/** The pending OpenCode permission ask. */
	ask: OcPermissionAsk;
	/** Answers the ask; resolves once rocket-agent has forwarded the reply. */
	onAnswer: (id: string, response: 'once' | 'always' | 'reject') => Promise<void>;
}

/** Inline approve/deny chips rendered in the chat input row when the agent asks for permission. */
export function PermissionPrompt({ ask, onAnswer }: PermissionPromptProps): React.JSX.Element {
	const [busy, setBusy] = useState(false);
	const run = (response: 'once' | 'always' | 'reject') => { setBusy(true); void onAnswer(ask.id, response).finally(() => setBusy(false)); };
	return (
		<div role="group" aria-label="Agent permission request" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
			<span>{ask.title ?? `Allow ${ask.type ?? 'action'}?`}</span>
			<button disabled={busy} onClick={() => run('once')}>Allow once</button>
			{/* "always" = remembered for the rest of the session (OpenCode ask semantics) — the "always allow pipe edits this session" affordance. P4-V3: confirm vs a separate `remember` flag. */}
			<button disabled={busy} onClick={() => run('always')}>Always (this session)</button>
			<button disabled={busy} onClick={() => run('reject')}>Deny</button>
		</div>
	);
}
