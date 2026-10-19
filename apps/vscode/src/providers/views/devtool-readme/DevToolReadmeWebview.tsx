// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DevToolReadmeWebview — the dev-tool details page as a shell bus realm.
 *
 * The tool's identity arrives stamped in the served HTML (`data-rr-args`);
 * everything else is mirror + ops: catalog facts off the mirrored
 * accountInfo (apps list), connection state off the mirrored status, the
 * pinned set via `host.devtools.installed` + the `changed` push, and
 * Install/Remove as fire-and-forget `host.devtools.*` ops. Icons are plain
 * engine URLs (base = the mirrored server HTTP URL).
 */

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { ConnectionManager } from 'shell';
import type { ConnectResult } from 'rocketride';
import { ToolDetailsView } from 'shared/tools/core/chrome/ToolDetailsView';

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

/** One account-payload app row, as this page reads it. */
interface IAppRow {
	id: string;
	name: string;
	version?: string;
	publisher?: string;
	description?: string;
	categories?: string[];
	icon?: string;
	readme?: string;
}

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

	const [account, setAccount] = useState<ConnectResult | null>(() => cm.getAccountInfo() ?? null);
	const [connected, setConnected] = useState(() => cm.isConnected());
	const [installedIds, setInstalledIds] = useState<string[] | null>(null);

	useEffect(() => {
		const offs = [
			cm.on('shell:accountUpdate', (data) => setAccount(data)),
			cm.on('shell:statusChange', () => setConnected(cm.isConnected())),
			cm.handle('host.devtools.changed', (p) => setInstalledIds((p as { ids: string[] }).ids)),
		];
		void cm.request('host.devtools.installed', {} as never).then(
			(r) => setInstalledIds((r as { ids: string[] }).ids),
			() => setInstalledIds([])
		);
		return () => offs.forEach((off) => off());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const apps = (account?.apps ?? []) as IAppRow[];
	const row = connected ? apps.find((a) => a?.id === appId) : undefined;

	if (installedIds === null || !row) {
		return <div style={statusStyle}>{installedIds === null ? 'Loading…' : connected ? 'This tool is no longer available on the server.' : 'Connect to a RocketRide server to view this tool.'}</div>;
	}

	// Engine-served icons are root-relative in the catalog; resolve against
	// the mirrored server HTTP base.
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
