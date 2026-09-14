// Copyright (c) 2026 Aparavi Software AG. MIT License.
import React from 'react';
import { AgentSessionView } from './AgentSessionView';

/** Renders an `agent:<sessionId>` static document as a main-area tab. */
export function AgentTab({ uri }: { uri: string }): React.JSX.Element {
	const sessionId = uri.slice('agent:'.length);
	if (!sessionId) return <div style={{ padding: 16 }}>Invalid agent session URI: {uri}</div>;
	return <AgentSessionView sessionId={sessionId} />;
}
