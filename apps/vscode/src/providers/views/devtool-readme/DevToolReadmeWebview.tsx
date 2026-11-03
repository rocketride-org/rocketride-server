// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DevToolReadmeWebview — the dev-tool details page as a shell bus realm.
 *
 * The tool's identity arrives stamped in the served HTML (`data-rr-args`);
 * the catalog row comes from the SERVER — the shared fetch over the
 * brokered `client.app.list` op, the same call every surface makes (never
 * the account list, which on SaaS is the user's DESKTOP and cannot name a
 * tool they have not gotten yet). Connection state off the mirrored
 * status, the pinned set via `host.devtools.installed` + the `changed`
 * push, Install/Remove as fire-and-forget `host.devtools.*` ops. Icons are
 * engine URLs; the page CSP admits the engine origin.
 */

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { ConnectionManager } from 'shell';
import { ToolDetailsView } from 'shared/tools/core/chrome/ToolDetailsView';
import { fetchDevToolCatalog } from 'shared/tools/core/devToolCatalog';
import type { AppManifestEntry } from 'shell';

const statusStyle: CSSProperties = {
	position: 'fixed',
	inset: 0,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	color: 'var(--rr-text-secondary)',
	fontSize: 13,
	fontFamily: 'var(--rr-font-family)',
	backgroundColor: 'var(--rr-bg-default)',
};



/** The page's open identity, stamped by the host into the served HTML. */
function stampedAppId(): string {
	try {
		const args = JSON.parse(document.body.dataset.rrArgs ?? '{}') as { appId?: unknown };
		return typeof args.appId === 'string' ? args.appId : '';
	} catch {
		return '';
	}
}

const DevToolReadmeWebview: React.FC = () => {
	const cm = ConnectionManager.getInstance();
	const appId = stampedAppId();

	const [catalog, setCatalog] = useState<AppManifestEntry[] | null>(null);
	const [connected, setConnected] = useState(() => cm.isConnected());
	const [installedIds, setInstalledIds] = useState<string[] | null>(null);

	useEffect(() => {
		const refresh = (): void => {
			setConnected(cm.isConnected());
			if (!cm.isConnected()) return;
			void fetchDevToolCatalog(cm.getClient()).then(setCatalog, () => setCatalog((prev) => prev ?? []));
		};
		refresh();
		const offs = [
			cm.on('shell:statusChange', refresh),
			cm.on('shell:accountUpdate', refresh),
			cm.handle('host.devtools.changed', (p) => setInstalledIds((p as { ids: string[] }).ids)),
		];
		void cm.request('host.devtools.installed', {} as never).then(
			(r) => setInstalledIds((r as { ids: string[] }).ids),
			() => setInstalledIds([])
		);
		return () => offs.forEach((off) => off());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const row = connected ? catalog?.find((a) => a?.id === appId) : undefined;

	if (installedIds === null || (connected && catalog === null) || !row) {
		return <div style={statusStyle}>{installedIds === null || catalog === null ? 'Loading…' : connected ? 'This tool is no longer available on the server.' : 'Connect to a RocketRide server to view this tool.'}</div>;
	}

	// Engine-served icons are root-relative in the catalog; the page CSP
	// admits the engine origin.
	const base = (cm.getHttpUrl() || '').replace(/\/$/, '');
	const iconUrl = row.icon ? (row.icon.startsWith('/') && base ? `${base}${row.icon}` : row.icon) : undefined;

	return (
		<ToolDetailsView
			tool={{
				id: row.id,
				name: row.name,
				...(row.publisher !== undefined ? { publisher: row.publisher } : {}),
				...(row.version !== undefined ? { version: row.version } : {}),
				...(row.description !== undefined ? { description: row.description } : {}),
				...(iconUrl !== undefined ? { iconUrl } : {}),
				// README from the manifest; the description is the fallback so
				// the page is never an empty sheet.
				readme: row.readme || row.description || '',
			}}
			installed={installedIds.includes(appId)}
			connected={connected}
			onInstall={() => cm.emitOp('host.devtools.install', { appId })}
			onRemove={() => cm.emitOp('host.devtools.remove', { appId })}
		/>
	);
};

export default DevToolReadmeWebview;
