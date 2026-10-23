// =============================================================================
// MIT License
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
// NEW CONNECTION MODAL — add or edit a saved connection, two paths
// =============================================================================
//
// "From pipeline": pick a database node DISCOVERED in the user's running
// pipelines (the old landing page's discovery, now scoped to this modal).
//
// "Direct": pick a database node type from the services catalog, then
// configure it with the shared NodeConfigForm — the pipeline editor's own
// config form (schema-driven, secured fields, `${ROCKETRIDE_*}` env
// references). The full Pipe schema is fetched on demand (the cached
// services summary may not carry it); the form mounts once it resolves.
// Save validates the single component server-side before persisting.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, ContentHeader, Modal } from 'shell';
import type { IFormData, IService, IServiceSchema } from 'shell';
import NodeConfigForm, { validationProblemFromResponse } from 'shared/components/node-config';
import type { INodeConfigFormHandle } from 'shared/components/node-config';
import { PIPELINE_SCHEMA_VERSION } from 'shared/components/node-config';
import {
	DATABASE_PROVIDERS,
	newConnectionId,
	refreshEndpoints, useSqlEndpoints,
} from '../connect';
import { useSqlEnv } from '../sqlEnv';
import type { SqlEndpoint, SavedSqlConnection } from '../connect';
import { DatabaseIcon } from '../icons';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Fallback titles when the services summary has not arrived yet (and in a dev-tool frame, which has no service cache). */
const PROVIDER_TITLES: Record<string, string> = {
	db_mysql: 'MySQL',
	db_postgres: 'PostgreSQL',
	db_clickhouse: 'ClickHouse',
	db_supabase: 'Supabase',
	rocketride_sql: 'RocketRide SQL',
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Path switch row (From pipeline / Direct). */
	pathRow: {
		display: 'flex',
		gap: 6,
		marginBottom: 14,
	} as CSSProperties,

	/** One path switch chip. */
	pathChip: (active: boolean): CSSProperties => ({
		padding: '5px 12px',
		borderRadius: 5,
		fontSize: 12.5,
		fontWeight: 600,
		cursor: 'pointer',
		border: `1px solid ${active ? 'var(--rr-brand)' : 'var(--rr-border)'}`,
		background: active ? 'var(--rr-bg-list-active)' : 'var(--rr-bg-input)',
		color: active ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
	}),

	/** Labelled field block. */
	field: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
		marginBottom: 12,
	} as CSSProperties,

	fieldLabel: {
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	input: {
		padding: '6px 10px',
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		borderRadius: 4,
		fontSize: 13,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Scrolling selection list (endpoints / providers). */
	list: {
		maxHeight: 260,
		overflowY: 'auto',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
	} as CSSProperties,

	/** One selectable row. */
	row: (selected: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '7px 10px',
		cursor: 'pointer',
		fontSize: 13,
		background: selected ? 'var(--rr-bg-list-active)' : 'transparent',
		color: selected ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
	}),

	rowDetail: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginLeft: 'auto',
		paddingLeft: 12,
	} as CSSProperties,

	/** Fixed glyph slot — the app icons fill whatever box they are given. */
	rowGlyph: {
		display: 'inline-flex',
		width: 16,
		height: 16,
		flexShrink: 0,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Muted state line inside the list box. */
	listEmpty: {
		padding: 14,
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Scroll region around the config form (direct path, modal chrome). */
	formScroll: {
		maxHeight: '48vh',
		overflowY: 'auto',
		paddingRight: 4,
	} as CSSProperties,

	bannerWrap: {
		marginBottom: 12,
	} as CSSProperties,

	// ── Page chrome (the top-level-tab flow) ─────────────────────────────────

	/** Document root: header + scrolling body column. */
	pageRoot: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
		minWidth: 0,
	} as CSSProperties,

	/** The page's single scroll region (the form scrolls with it). */
	pageScroll: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: '16px 24px 24px',
	} as CSSProperties,

	/** Form column, modal-width so the fields don't stretch across the tab. */
	pageBody: {
		maxWidth: 560,
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/** Props for {@link NewConnectionModal}. */
export interface NewConnectionModalProps {
	/** The connection being edited, or null to create a new one. */
	editing: SavedSqlConnection | null;
	/** Close the editor (saved or cancelled). */
	onClose: () => void;
	/** Called with the saved record (id included) after a save. */
	onSaved?: (saved: SavedSqlConnection) => void;
	/** Render as a full document page (ContentHeader + body) instead of a
	 *  modal — the top-level-tab flow. */
	page?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The add/edit connection modal: the pipeline-discovery path and the direct
 * node-config path behind one path switch.
 *
 * @param props - {@link NewConnectionModalProps}.
 */
const NewConnectionModal: React.FC<NewConnectionModalProps> = ({ editing, onClose, onSaved, page = false }) => {
	const env = useSqlEnv();

	// ── Shared state ─────────────────────────────────────────────────────────
	const [path, setPath] = useState<'pipeline' | 'direct'>(editing?.mode ?? 'pipeline');
	const [name, setName] = useState(editing?.name ?? '');
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);

	// ── Pipeline path: discovery ─────────────────────────────────────────────
	const { status, endpoints, error: discoveryError } = useSqlEndpoints();
	const [selectedKey, setSelectedKey] = useState<string | null>(
		editing?.mode === 'pipeline' ? `${editing.projectId}:${editing.source}:${editing.nodeId}` : null,
	);
	useEffect(() => {
		if (env.ready) void refreshEndpoints(() => env.discoverEndpoints());
	}, [env]);

	// ── Direct path: provider pick + schema fetch ────────────────────────────
	const [provider, setProvider] = useState<string | null>(editing?.mode === 'direct' ? editing.provider : null);
	const [service, setService] = useState<IService | null>(null);
	const [schemaError, setSchemaError] = useState('');
	const [config, setConfig] = useState<IFormData>(editing?.mode === 'direct' ? editing.config : {});
	const [envKeys, setEnvKeys] = useState<string[]>([]);
	const formRef = useRef<INodeConfigFormHandle | null>(null);

	// Provider titles from the cached services summary (fallback map until it
	// arrives — the summary fetch is lazy and connection-scoped).
	const providerTitle = useCallback((p: string): string => env.serviceTitle(p) ?? PROVIDER_TITLES[p] ?? p, [env]);

	// The full Pipe schema is fetched on demand once a provider is picked.
	useEffect(() => {
		if (!provider || !env.ready) { setService(null); return; }
		let alive = true;
		setService(null);
		setSchemaError('');
		void (async () => {
			try {
				const def = (await env.getService(provider)) as IService | undefined;
				if (!alive) return;
				if (!def?.Pipe) {
					setSchemaError(`No configuration schema for ${providerTitle(provider)}.`);
					return;
				}
				setService(def);
			} catch (err) {
				if (alive) setSchemaError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => { alive = false; };
	}, [provider, env, providerTitle]);

	// Env-var names feed the form's `${}` autocomplete (server-encrypted values).
	useEffect(() => {
		if (!env.ready) { setEnvKeys([]); return; }
		void env.getEnvironmentKeys().then((keys) => setEnvKeys(keys));
	}, [env]);

	// ── Save paths ───────────────────────────────────────────────────────────

	/** Persists the pipeline-bound record from the selected endpoint. */
	const savePipeline = useCallback(async () => {
		const endpoint = endpoints.find((e: SqlEndpoint) => e.key === selectedKey);
		if (!endpoint) { setError('Select a database node.'); return; }
		const record: SavedSqlConnection = {
			id: editing?.id ?? newConnectionId(),
			mode: 'pipeline' as const,
			name: name.trim() || endpoint.nodeName,
			projectId: endpoint.projectId,
			pipelineName: endpoint.pipelineName,
			source: endpoint.source,
			nodeId: endpoint.nodeId,
			provider: endpoint.provider,
		};
		setSaving(true);
		try {
			// Committed where the list is owned: the full app's core, or the
			// dev tool's controller (an op). A failure keeps the editor open.
			await env.saveConnection(record);
			onSaved?.(record);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [endpoints, selectedKey, name, editing, env, onClose, onSaved]);

	/** Validates the configured component server-side, then persists. */
	const saveDirect = useCallback(async (formData: IFormData) => {
		if (!provider) return;
		setSaving(true);
		setError('');
		try {
			if (env.ready) {
				// Single-component validate payload (the editor's shape). The
				// `ui` block is canvas bookkeeping the validator ignores, but
				// IProjectComponent requires it structurally.
				const payload = {
					version: PIPELINE_SCHEMA_VERSION,
					component: {
						id: `${provider}_1`,
						provider,
						config: formData,
						ui: { position: { x: 0, y: 0 }, measured: { width: 0, height: 0 }, nodeType: 'service' },
					},
				};
				const resp = await env.validate(payload as unknown as Record<string, unknown>);
				const problem = validationProblemFromResponse(resp);
				if (problem) throw new Error(problem);
			}
			const record: SavedSqlConnection = {
				id: editing?.id ?? newConnectionId(),
				mode: 'direct' as const,
				name: name.trim() || providerTitle(provider),
				provider,
				config: formData,
			};
			await env.saveConnection(record);
			onSaved?.(record);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [provider, env, name, editing, onClose, onSaved, providerTitle]);

	/** Footer Save — routes to the active path. */
	const handleSave = useCallback(() => {
		setError('');
		if (path === 'pipeline') void savePipeline();
		// Direct: drive the RJSF submit; saveDirect runs on validation pass.
		else formRef.current?.submit();
	}, [path, savePipeline]);

	// No list-readiness gate here: the save runs where the list is owned, and
	// waits there for the list to be read for the signed-in identity, so it
	// can never land on a half-loaded list (or another account's).
	const saveReady = path === 'pipeline' ? selectedKey !== null : provider !== null && service !== null;

	// Database providers, stable order (the discovery set is the source of truth).
	const dbProviders = useMemo(() => [...DATABASE_PROVIDERS].sort(), []);

	// ── Render ───────────────────────────────────────────────────────────────

	const title = editing ? 'Edit Connection' : 'New Connection';
	const footer = (
		<>
			<Button variant="primary" onClick={handleSave} disabled={!saveReady || saving || !env.ready}>
				{saving ? 'Validating…' : 'Save'}
			</Button>
			<Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
		</>
	);

	const body = (
		<>
			{/* Path switch. */}
			<div style={styles.pathRow}>
				<div role="button" tabIndex={0} style={styles.pathChip(path === 'pipeline')} onClick={() => setPath('pipeline')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPath('pipeline'); }}>
					From pipeline
				</div>
				<div role="button" tabIndex={0} style={styles.pathChip(path === 'direct')} onClick={() => setPath('direct')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPath('direct'); }}>
					Direct
				</div>
			</div>

			{/* Error surface (validate failures, selection errors). */}
			{error && <div style={styles.bannerWrap}><Banner variant="error">{error}</Banner></div>}

			{/* Connection name (both paths; defaults applied on save). */}
			<div style={styles.field}>
				<span style={styles.fieldLabel}>Name</span>
				<input
					style={styles.input}
					value={name}
					placeholder={path === 'pipeline' ? 'Defaults to the node name' : provider ? `Defaults to ${providerTitle(provider)}` : 'Connection name'}
					onChange={(e) => setName(e.target.value)}
				/>
			</div>

			{path === 'pipeline' ? (
				<div style={styles.field}>
					<span style={styles.fieldLabel}>Database nodes in your running pipelines</span>
					<div style={styles.list}>
						{discoveryError && <div style={styles.listEmpty}>{discoveryError}</div>}
						{!discoveryError && endpoints.length === 0 && (
							<div style={styles.listEmpty}>
								{status === 'loading' || status === 'idle'
									? 'Searching running pipelines…'
									: 'No database nodes found. Start a pipeline containing a database node (MySQL, PostgreSQL, ClickHouse, or RocketRide SQL), then reopen this dialog.'}
							</div>
						)}
						{endpoints.map((endpoint: SqlEndpoint) => (
							<div
								key={endpoint.key}
								role="button"
								tabIndex={0}
								style={styles.row(selectedKey === endpoint.key)}
								onClick={() => setSelectedKey(endpoint.key)}
								onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedKey(endpoint.key); }}
							>
								<span style={styles.rowGlyph}><DatabaseIcon /></span>
								<span>{endpoint.nodeName}</span>
								<span style={styles.rowDetail}>{endpoint.pipelineName} · {providerTitle(endpoint.provider)}</span>
							</div>
						))}
					</div>
				</div>
			) : (
				<>
					{/* Provider picker. */}
					<div style={styles.field}>
						<span style={styles.fieldLabel}>Database type</span>
						<div style={styles.list}>
							{dbProviders.map((p) => (
								<div
									key={p}
									role="button"
									tabIndex={0}
									style={styles.row(provider === p)}
									onClick={() => { setProvider(p); setConfig({}); }}
									onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setProvider(p); setConfig({}); } }}
								>
									<span style={styles.rowGlyph}><DatabaseIcon /></span>
									<span>{providerTitle(p)}</span>
									<span style={styles.rowDetail}>{p}</span>
								</div>
							))}
						</div>
					</div>

					{/* Config form — mounts once the full schema resolves. */}
					{schemaError && <div style={styles.bannerWrap}><Banner variant="error">{schemaError}</Banner></div>}
					{provider && !service && !schemaError && <div style={styles.listEmpty}>Loading configuration…</div>}
					{provider && service?.Pipe && (
						<div style={page ? undefined : styles.formScroll}>
							<NodeConfigForm
								key={provider}
								ref={formRef}
								provider={provider}
								schema={service.Pipe as IServiceSchema}
								formData={config}
								onChange={setConfig}
								onSubmit={(formData) => { void saveDirect(formData); }}
								envKeys={envKeys}
								disabled={saving}
							/>
						</div>
					)}
				</>
			)}
		</>
	);

	// Page chrome: a full document (the top-level-tab flow) — header with the
	// actions, body in its own scroll region. Modal chrome otherwise.
	if (page) {
		return (
			<div style={styles.pageRoot}>
				<ContentHeader title={title} subtitle="Connect to a database through a pipeline node or directly" actions={footer} />
				<div style={styles.pageScroll}>
					<div style={styles.pageBody}>{body}</div>
				</div>
			</div>
		);
	}

	return (
		<Modal title={title} onClose={onClose} width={560} footer={footer}>
			{body}
		</Modal>
	);
};

export default NewConnectionModal;
