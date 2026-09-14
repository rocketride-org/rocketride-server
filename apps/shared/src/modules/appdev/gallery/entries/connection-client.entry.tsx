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
// CONNECTION & CLIENT — GALLERY ENTRY (DOC-ONLY, HOOKS)
// =============================================================================

/** Doc-only gallery entry for the connection layer and RocketRide client access. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Connection & client gallery entry. */
export const connectionClientEntry: IGalleryEntry = {
	id: 'connection-client',
	name: 'Connection & client',
	group: 'hooks',
	blurb: 'The ONE connection: the shell-owned ConnectionManager singleton, the shared RocketRideClient it serves, and the hooks apps use to reach both.',
	doc: `The shell exclusively owns auth and the client — apps never construct a \`RocketRideClient\` or wire their own connection. Everything flows from the \`ConnectionManager\` singleton the shell initializes at boot:

- \`useShellConnection()\` — the everyday hook: the client, \`isConnected\`, and the transient status message, re-rendering on change.
- \`useClient()\` — just the client (null until connected); \`getClient()\` is the non-React accessor for callbacks and module code.
- \`useConnectionStatus()\` — the full state machine (\`ConnectionState\`, mode, retry attempt, last error) for connection-aware UI beyond a boolean.

All client traffic is DAP over the one WebSocket — there is no per-feature HTTP.`,
	docNote: 'Apps NEVER initialize the ConnectionManager, construct clients, or handle auth - that is shell bootstrap. Consume the connection; do not create it.',
	code: `import { useShellConnection, useClient, getClient, Button } from 'shell';

function RunButton() {
	const { isConnected } = useShellConnection();
	const client = useClient();
	if (!client) return null;
	return <Button disabled={!isConnected} onClick={() => client.use({ pipeline })}>Run</Button>;
}

// Outside React (module code, event handlers):
const client = getClient();
if (client) await client.listTasks({ page: 1, page_size: 50 });`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'useShellConnection', type: '() => { client, isConnected, statusMessage }', dir: 'out', note: 'The everyday connection hook; re-renders on connect/disconnect and status-message changes.' },
		{ name: 'useClient', type: '() => RocketRideClient | null', dir: 'out', note: 'The shared client, null until connected.' },
		{ name: 'getClient', type: '() => RocketRideClient | null', dir: 'out', note: 'Non-React accessor to the same singleton client.' },
		{ name: 'useConnectionStatus', type: '() => ConnectionStatus', dir: 'out', note: 'Full state machine: state, connectionMode, retryAttempt, lastError, progressMessage.' },
	],
	sections: [
		{
			label: 'ConnectionManager (advanced)',
			rows: [
				{ name: 'getInstance', type: '() => ConnectionManager', dir: 'out', note: 'The singleton accessor - the entry point for emit/on and status queries.' },
				{ name: 'emit / on / onAny', type: '(event, payload) / (event, handler) => unsubscribe', dir: 'in', note: 'The typed shell event bus (see the Shell events entry). on() replays buffered user-intent events.' },
				{ name: 'isConnected / isConnecting / isDisconnected', type: '() => boolean', dir: 'out', note: 'Imperative state checks mirroring ConnectionStatus.' },
				{ name: 'getConnectionStatus / getAccountInfo', type: '() => ConnectionStatus / ConnectResult | undefined', dir: 'out', note: 'Current status object / the authenticated account result.' },
				{ name: 'getDebugLog / clearDebugLog', type: '() => DebugLogEntry[] / () => void', dir: 'out', note: 'The event trace the ALT+D DebugPanel renders ({ timestamp, event, payload }).' },
				{ name: 'initialize / connect / disconnect / logout', type: '(InitOptions?) / (credential?) / () / ()', dir: 'in', note: 'Lifecycle - HOST BOOTSTRAP ONLY; apps never call these.' },
			],
		},
		{
			label: 'Types',
			rows: [
				{ name: 'ConnectionState', type: "enum: 'disconnected' | 'connecting' | 'connected' | 'failed' | 'auth-failed'", dir: 'in', note: 'The connection state machine values.' },
				{ name: 'ConnectionMode', type: "'cloud' | 'local' | 'onprem' | 'docker' | 'service' | 'oss'", dir: 'in', note: 'Deployment/credential strategy the host configured.' },
				{ name: 'InitOptions', type: '{ uri?, clientName?, env?, connectionMode?, authProvider? }', dir: 'in', note: 'Host bootstrap options for initialize().' },
				{ name: 'RocketRideClient', type: 'rocketride SDK client', dir: 'in', note: 'The shared MF singleton client; its full surface is part of the frozen shell contract.' },
			],
		},
	],
};
