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
// POLLING & DASHBOARD DATA — GALLERY ENTRY (DOC-ONLY, HOOKS)
// =============================================================================

/** Doc-only gallery entry for connection-gated interval polling. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Polling gallery entry. */
export const dataPollingEntry: IGalleryEntry = {
	id: 'data-polling',
	name: 'Polling',
	group: 'hooks',
	blurb: 'Connection-gated interval polling (usePolling) for views that re-fetch on a cadence.',
	doc: `\`usePolling(fetcher, interval)\` fires immediately, then every \`interval\` ms, and by default only while the shell is connected (\`gate: 'shell'\`), so views never poll into a dead socket. Pass \`{ gate: 'none' }\` for unconditional polling.

For data several views share, wrap the poll in a module-singleton hook (first consumer starts it, last unmount stops it) so N views cost one request — the Server Monitor tool's dashboard feed is the reference implementation of that pattern.`,
	docNote: 'Do not hand-roll a poll-every-N-seconds effect per view - share one gated poll behind a singleton hook.',
	code: `import { usePolling } from 'shell';

// A view-specific poll, gated on the connection by default:
usePolling(() => refreshRunList(), 5000);`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'usePolling', type: '(fetcher: () => void | Promise<void>, interval: number, options?: IUsePollingOptions) => void', dir: 'out', note: 'Fires immediately then every interval ms; connection-gated by default.' },
	],
	sections: [
		{
			label: 'Types',
			rows: [
				{ name: 'IUsePollingOptions', type: "{ gate?: 'shell' | 'none' }", dir: 'in', note: "'shell' (default) polls only while connected; 'none' polls unconditionally." },
				{ name: 'ListPageRequest / ListPageResponse', type: 'paged list contract (rocketride)', dir: 'in', note: 'The request/response shape of the server list_* APIs that feed DataGrid.fetchPage — from the SDK.' },
			],
		},
	],
};
