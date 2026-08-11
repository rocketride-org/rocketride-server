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

/** Doc-only gallery entry for usePolling and the shared dashboard data feed. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Polling & dashboard data gallery entry. */
export const dataPollingEntry: IGalleryEntry = {
	id: 'data-polling',
	name: 'Polling & dashboard data',
	group: 'hooks',
	blurb: 'Connection-gated interval polling (usePolling) and the ONE shared dashboard feed every overview view reads (useDashboardData).',
	doc: `\`usePolling(fetcher, interval)\` fires immediately, then every \`interval\` ms — and by default only while the shell is connected (\`gate: 'shell'\`), so views never poll into a dead socket. Pass \`{ gate: 'none' }\` for unconditional polling.

\`useDashboardData()\` is the shared feed: a module singleton where the FIRST consumer starts the 3s poll plus the \`shell:event\` subscription and the LAST unmount stops it. Every dashboard-ish view reads this one hook instead of rolling its own poll — data survives view switches, and there is exactly one request in flight regardless of how many views listen.`,
	docNote: 'Do not hand-roll a poll-every-N-seconds effect for dashboard data - the shared feed exists so N views cost one poll.',
	code: `import { usePolling, useDashboardData } from 'shell';

// A view-specific poll, gated on the connection by default:
usePolling(() => refreshRunList(), 5000);

// The shared dashboard feed - one poll for every consumer:
function OverviewTiles() {
	const { data, events, error, refresh } = useDashboardData();
	if (error) return <Banner variant="error">{error}</Banner>;
	return <MiniContainer>{/* tiles from data.overview */}</MiniContainer>;
}`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'usePolling', type: '(fetcher: () => void | Promise<void>, interval: number, options?: IUsePollingOptions) => void', dir: 'out', note: 'Fires immediately then every interval ms; connection-gated by default.' },
		{ name: 'useDashboardData', type: '() => DashboardData', dir: 'out', note: 'The shared singleton feed: 3s poll + live shell:event merge, refcounted by consumers.' },
	],
	sections: [
		{
			label: 'Types',
			rows: [
				{ name: 'IUsePollingOptions', type: "{ gate?: 'shell' | 'none' }", dir: 'in', note: "'shell' (default) polls only while connected; 'none' polls unconditionally." },
				{ name: 'DashboardData', type: '{ data, events, error, refresh }', dir: 'in', note: 'The current DashboardResponse (null until first load), activity events newest-first, last error, and a manual refresh.' },
				{ name: 'DashboardResponse et al.', type: 'DashboardOverview / DashboardConnection / DashboardTask / DashboardEvent / TaskEvent / ActivityEvent', dir: 'in', note: 'The server dashboard payload types, all exported from the surface.' },
				{ name: 'ListPageRequest / ListPageResponse', type: 'paged list contract', dir: 'in', note: 'The request/response shape of the server list_* APIs that feed DataGrid.fetchPage.' },
			],
		},
	],
};
