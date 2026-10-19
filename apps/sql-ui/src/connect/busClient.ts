// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// BUS CLIENT — the sql tool's engine surface over the shell bus
// =============================================================================
//
// The structural subset of the SDK client this tool uses, implemented as
// brokered `client.*` ops (in-process at the framework root, bridged in
// spoke realms). ONE module-level instance: the session cache keys on it,
// and a reconnect no longer swaps the identity — sessions already
// re-resolve dead task tokens on failure (session.ts retry), which covers
// the reconnect case the old client-identity check covered.
// =============================================================================

import { ConnectionManager } from 'shell';

/** The engine calls the sql connect stack makes — bus-backed. */
export interface SqlWireClient {
	isConnected(): boolean;
	listTasks(req: Record<string, unknown>): Promise<{ rows?: unknown[] } & Record<string, unknown>>;
	getTaskToken(args: { projectId: string; source: string; teamId?: string }): Promise<string | undefined>;
	getTaskPipeline(token: string): Promise<unknown>;
	use(options: Record<string, unknown>): Promise<unknown>;
	terminate(token: string): Promise<unknown>;
	tool<T>(args: { token: string; tool: string; nodeId?: string; input?: unknown; timeout?: number }): Promise<T>;
	getService(provider: string): Promise<unknown>;
	validate(args: { pipeline: unknown }): Promise<{ errors: unknown[]; warnings: unknown[] }>;
	fsMkdir(path: string): Promise<unknown>;
	fsWriteJson(path: string, value: unknown): Promise<unknown>;
	fsReadJson(path: string): Promise<unknown>;
	getEnvironmentKeys(): Promise<string[]>;
}

let instance: SqlWireClient | null = null;

/**
 * The realm's bus-backed sql client — one stable identity per realm.
 *
 * @returns The adapter.
 */
export function getBusSqlClient(): SqlWireClient {
	if (instance) return instance;
	const cm = ConnectionManager.getInstance();
	instance = {
		isConnected: () => cm.isConnected(),
		listTasks: (req) => cm.request('client.listTasks', req) as Promise<{ rows?: unknown[] }>,
		getTaskToken: (args) => cm.request('client.getTaskToken', args) as Promise<string | undefined>,
		getTaskPipeline: (token) => cm.request('client.getTaskPipeline', { token }),
		use: (options) => cm.request('client.use', options),
		terminate: (token) => cm.request('client.terminate', { token }),
		tool: <T,>(args: { token: string; tool: string; nodeId?: string; input?: unknown; timeout?: number }) => cm.request('client.tool', args) as Promise<T>,
		getService: (provider) => cm.request('client.getService', { service: provider }),
		validate: (args) => cm.request('client.validate', args) as Promise<{ errors: unknown[]; warnings: unknown[] }>,
		fsMkdir: (path) => cm.request('client.fsMkdir', { path }),
		fsWriteJson: (path, value) => cm.request('client.fsWriteJson', { path, value }),
		fsReadJson: (path) => cm.request('client.fsReadJson', { path }),
		getEnvironmentKeys: async () => {
			try {
				return (await cm.request('client.getEnvironmentKeys', {})) as string[];
			} catch {
				return [];
			}
		},
	};
	return instance;
}
