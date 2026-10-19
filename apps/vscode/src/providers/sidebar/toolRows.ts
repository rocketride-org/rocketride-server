// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TOOL ROWS — pinned dev-tool rows + the catalog, composed for the webview
// =============================================================================
//
// The network-derived tool data behind the sidebar's strip and Store panel:
// pinned ids resolved against the connection's account apps, icons inlined
// as data: URIs (the same CSP story as the MY APPS rows — the webview
// renders instantly from the payload, with no cross-origin load to be
// blocked or to arrive late), and the full devTool catalog. A last-known
// row cache (workspaceState) lets the strip seed paint tool tabs in their
// final shape before any connection exists.
// =============================================================================

import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../connection/connection';
import type { DevToolStore } from '../DevToolStore';

/** workspaceState key for the last-known pinned tool rows (name + inlined
 *  icon), keyed by app id. */
const TOOL_META_KEY = 'rr.devToolMeta';

/** Upper bound on one tool-icon fetch — a hung engine endpoint degrades that
 *  icon, never the update it rides in. */
const ICON_FETCH_TIMEOUT_MS = 5000;

/** One pinned dev-tool row sent to the webview (shared ToolTab shape). */
export interface ToolRowDTO {
	id: string;
	name: string;
	iconUrl?: string;
	version?: string;
	/** Short description (the modules list's second line). */
	description?: string;
	/** MF container name — the sidebar's devToolSidebar mount loads by it. */
	moduleId?: string;
	/** Registry version resolving the remote entry URL. */
	registryVersion?: number;
}

/** The account-app shape the rows read (SDK payload subset). */
interface AccountApp {
	id: string;
	name?: string;
	icon?: string;
	version?: string;
	description?: string;
	categories?: string[];
	moduleId?: string;
	registryVersion?: number;
}

export class ToolRows {
	/** Fetched tool icons as data: URIs, by source URL — immutable per URL. */
	private iconCache = new Map<string, string>();

	constructor(
		private readonly connectionManager: ConnectionManager,
		private readonly devTools?: DevToolStore,
		private readonly context?: vscode.ExtensionContext
	) {}

	/**
	 * Fetches an engine-served icon and inlines it as a data: URI. Time-boxed:
	 * this await chain sits inside the extras compose, and a hung engine must
	 * cost this one icon, not stall the whole update.
	 */
	private async iconDataUri(url: string): Promise<string | undefined> {
		const cached = this.iconCache.get(url);
		if (cached) return cached;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), ICON_FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(url, { signal: abort.signal });
			if (!res.ok) return undefined;
			const contentType = res.headers.get('content-type')?.split(';')[0] || 'image/svg+xml';
			const dataUri = `data:${contentType};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
			this.iconCache.set(url, dataUri);
			return dataUri;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}

	/** The connection's account apps (empty when disconnected). */
	private accountApps(): AccountApp[] {
		return (this.connectionManager.getClient()?.getAccountInfo()?.apps ?? []) as AccountApp[];
	}

	/** The engine base URL for resolving server-relative icon paths. */
	private engineBase(): string {
		return (this.connectionManager.getHttpUrl() || '').replace(/\/$/, '');
	}

	/** An app's icon URL resolved against the engine base (undefined = none). */
	private resolveIconUrl(icon: string | undefined, base: string): string | undefined {
		return icon ? (icon.startsWith('/') && base ? `${base}${icon}` : icon) : undefined;
	}

	/** The persisted last-known tool rows, by app id (see {@link TOOL_META_KEY}). */
	private readToolMeta(): Record<string, ToolRowDTO> {
		return this.context?.workspaceState.get<Record<string, ToolRowDTO>>(TOOL_META_KEY) ?? {};
	}

	/** The pinned rows from the last-known cache alone — the strip seed's
	 *  source, and the fallback when a fresh compose fails. */
	cachedRows(): ToolRowDTO[] {
		const cached = this.readToolMeta();
		return (this.devTools?.getAll() ?? []).map((id): ToolRowDTO => cached[id] ?? { id, name: id });
	}

	/**
	 * Builds the pinned-tool rows: the workspace's pinned ids resolved against
	 * the connection's account apps (name, version, icon inlined as a data:
	 * URI). A pinned id the account no longer carries still rows up by id so
	 * the user can unpin it.
	 */
	async buildToolRows(): Promise<ToolRowDTO[]> {
		const pinned = this.devTools?.getAll() ?? [];
		if (pinned.length === 0) return [];
		const base = this.engineBase();
		const byId = new Map(this.accountApps().filter((a) => a?.id).map((a) => [a.id, a]));
		const cached = this.readToolMeta();
		const rows = await Promise.all(pinned.map(async (id): Promise<ToolRowDTO> => {
			const row = byId.get(id);
			// Not in the account payload (disconnected, or genuinely gone):
			// the last-known row keeps the tab stable; a never-seen id still
			// rows up bare so the user can unpin it.
			if (!row) return cached[id] ?? { id, name: id };
			const iconUrl = this.resolveIconUrl(row.icon, base);
			return {
				id,
				name: row.name ?? id,
				iconUrl: iconUrl ? await this.iconDataUri(iconUrl) : undefined,
				version: row.version,
				moduleId: row.moduleId,
				registryVersion: row.registryVersion,
			};
		}));
		// Persist the rows (fresh where resolved, last-known otherwise) keyed
		// by pinned id — the next boot's strip seed renders from this cache
		// before any connection exists. Unpinned ids fall out naturally.
		const meta = Object.fromEntries(rows.map((r) => [r.id, r]));
		if (JSON.stringify(meta) !== JSON.stringify(cached)) {
			void this.context?.workspaceState.update(TOOL_META_KEY, meta);
		}
		return rows;
	}

	/**
	 * Builds the full dev-tool catalog (the modules list): every account app
	 * carrying the devTool category, installed or not, icons inlined.
	 */
	async buildAvailableTools(): Promise<ToolRowDTO[]> {
		if (!this.connectionManager.isConnected()) return [];
		const base = this.engineBase();
		const rows = this.accountApps().filter((a) => a?.id && a.categories?.some((c) => c.toLowerCase() === 'devtool'));
		const built = await Promise.all(rows.map(async (a) => {
			const iconUrl = this.resolveIconUrl(a.icon, base);
			return {
				id: a.id,
				name: a.name ?? a.id,
				iconUrl: iconUrl ? await this.iconDataUri(iconUrl) : undefined,
				version: a.version,
				description: a.description,
				moduleId: a.moduleId,
				registryVersion: a.registryVersion,
			};
		}));
		return built.sort((a, b) => a.name.localeCompare(b.name));
	}
}
