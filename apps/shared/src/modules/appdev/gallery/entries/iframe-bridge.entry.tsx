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
// IFRAME BRIDGE — GALLERY ENTRY (DOC-ONLY, HOOKS)
// =============================================================================

/** Doc-only gallery entry for the shell-to-iframe postMessage bridge. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Iframe bridge gallery entry. */
export const iframeBridgeEntry: IGalleryEntry = {
	id: 'iframe-bridge',
	name: 'Iframe bridge',
	group: 'hooks',
	blurb: 'The typed shell-to-iframe postMessage protocol for iframe-hosted app views: one hook on the shell side, a small message vocabulary inside the frame.',
	doc: `An iframe-hosted view attaches \`useIframeBridge(iframeRef)\` to its frame and gets the whole protocol: the shell waits for the frame's \`view:ready\`, answers with \`shell:init\` (theme tokens, user, connection state, API config), then forwards theme changes, connection changes, login/logout, server events, and view activation as they happen. Inbound, the frame can request \`shell:logout\` and \`shell:openTab\`.

Keep the frame hidden (\`visibility: hidden\`) until \`view:ready\` has been answered — that is the flash-free pattern; theme CSS for the initial paint belongs in the srcdoc itself.`,
	docNote: 'The bridge forwards shell events only AFTER the frame signals view:ready - an iframe that skips the handshake receives nothing.',
	code: `// Shell side - the hosting view wires the bridge to its frame:
import { useIframeBridge } from 'shell';

function EmbeddedView({ src }) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	useIframeBridge(frameRef);
	return <iframe ref={frameRef} src={src} style={{ visibility: hidden ? 'hidden' : 'visible' }} />;
}

// Iframe side - the handshake:
window.parent.postMessage({ type: 'view:ready' }, '*');
window.addEventListener('message', ({ data }) => {
	if (data.type === 'shell:init') applyTheme(data.theme);   // ShellInitMsg
});`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'useIframeBridge', type: '(iframeRef: RefObject<HTMLIFrameElement>) => void', dir: 'out', note: 'Attaches the full bridge: handshake, shell:init bootstrap, event forwarding, inbound request handling.' },
	],
	sections: [
		{
			label: 'Protocol types',
			rows: [
				{ name: 'ShellInitMsg', type: '{ type, theme, user, isConnected, apiConfig }', dir: 'out', note: 'The bootstrap message sent after view:ready - theme tokens, identity, connection state, API config.' },
				{ name: 'ShellToIframeMsg', type: 'union', dir: 'out', note: 'Everything the shell posts: init, theme change, connection change, login/logout, server events, view activation.' },
				{ name: 'IframeToShellMsg', type: 'union', dir: 'in', note: 'Everything the frame may post: view:ready, view:initialized, shell:logout, shell:openTab.' },
			],
		},
	],
};
