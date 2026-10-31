// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PipelineWebview — this host's DOCUMENT SEAM around the shared editor.
 *
 * The editor itself (canvas, sections, deploy page, record drawers, DVR,
 * monitors, event folding) is the shared {@link PipelineEditor}; what lives
 * here is exactly what VS Code owns and no other host does:
 *
 *   - the TextDocument: boot state rides host.pipeline.load (the panel's
 *     identity is stamped in the served HTML as data-rr-doc), dirty/new ride
 *     the pipeline:doc:<doc> retained topic, content changes go back through
 *     host.pipeline.contentSet, and save/publish/run resolve host-side
 *     (settings, snapshotting, the run gate);
 *   - the OAuth round-trip (tokens land on the doc's retained topic and the
 *     applying content change is stamped saveAfter);
 *   - the checkout overlay (the host's run gate signals it; the webview
 *     sells through its own CheckoutModal);
 *   - webview-state persistence for the view state.
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';

import { PipelineEditor } from 'shared/tools/pipelines/PipelineEditor';
import type { IPipelineEditorHost } from 'shared/tools/pipelines/PipelineEditor';
import type { ViewState } from 'shared/tools/pipelines';
import { CheckoutModal } from 'shell';
import type { CheckoutPlan, PlanAction } from 'shell';
import { createMirroredPrefsStore, useGridConfigAnswering, ConnectionManager } from 'shell';
import { SHELL_PARTITION } from 'shell/src/workspace/workspaceStore';
import { isAppSubscribed } from 'shared/utils/subscriptionGate';
import { PIPE_BUILDER_APP_ID } from '../../../shared/types';
import { useMessaging } from '../hooks/useMessaging';
import { useStripeKey } from '../hooks/useStripeKey';
import { CheckoutUnavailableNotice } from '../components';
import type { PipelineHostToWebview, PipelineWebviewToHost } from '../../types/pipelineTypes';

// =============================================================================
// COMPONENT
// =============================================================================

const PipelineWebview: React.FC = () => {
	// --- Document state (host-owned, mirrored here) ---------------------------

	const [project, setProject] = useState<any>(null);
	const [viewState, setViewState] = useState<ViewState | undefined>(undefined);
	const [oauthReturnUrl, setOauthReturnUrl] = useState<string | undefined>(undefined);
	const [pendingOAuthTokens, setPendingOAuthTokens] = useState<{ tokens: string; state: string } | undefined>(undefined);
	const [isDirty, setIsDirty] = useState(false);
	const [isNew, setIsNew] = useState(false);
	const [subscribed, setSubscribed] = useState(true);
	const [isReadonly, setIsReadonly] = useState(false);
	const [showCheckout, setShowCheckout] = useState(false);
	// Server-supplied Stripe publishable key — matches the connected server's
	// Stripe account instead of a build-time value.
	const { key: stripeKey, reason: stripeKeyReason } = useStripeKey();
	const [cloudConnectionConfigured, setCloudConnectionConfigured] = useState(false);
	// Host-pushed env-key updates (the Variables page saved) — delivered into
	// the shared editor through the seam's feed.
	const envKeysApplyRef = useRef<((keys: string[]) => void) | null>(null);

	// This panel's bus identity (the document URI, or task:<pid>.<sid> for
	// the readonly live-task viewer) — stamped into the served HTML, present
	// before any script ran.
	const docRef = useRef<string>(document.body.dataset.rrDoc ?? '');
	// OAuth tokens were just applied: the next contentSet must reach disk
	// without a manual save (the one-shot coupling, stamped realm-side).
	const saveAfterOAuthRef = useRef(false);

	// --- Boot + document topics -----------------------------------------------

	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		const doc = docRef.current;
		// The document's boot state — pulled, with one retry when the first
		// attempt raced the connection (the load op itself is host-local).
		const applyLoad = (payload: Record<string, any>): void => {
			// Restore saved webview state if available (survives tab switches)
			const saved = getStateRef.current();
			const vs = (saved && Object.keys(saved).length > 0 ? saved : payload.viewState) as ViewState | undefined;
			setProject(payload.project);
			if (payload.isSubscribed !== undefined) setSubscribed(payload.isSubscribed);
			setIsReadonly(payload.isReadonly ?? false);
			setViewState({
				mode: vs?.mode ?? 'design',
				flowViewMode: vs?.flowViewMode ?? 'pipeline',
				viewport: vs?.viewport,
			});
			// Unconditional: a load without a return URL must clear any stale
			// one, and a reload must not keep tokens from a previous session.
			setOauthReturnUrl(payload.oauthReturnUrl);
			setPendingOAuthTokens(undefined);
			if (payload.envKeys) envKeysApplyRef.current?.(payload.envKeys);
		};
		void cm.request('host.pipeline.load', { doc } as never).then(
			(payload) => applyLoad(payload as Record<string, any>),
			() => {
				const offRetry = cm.on('shell:connected', () => {
					offRetry();
					void cm.request('host.pipeline.load', { doc } as never).then((payload) => applyLoad(payload as Record<string, any>), () => {});
				});
			}
		);

		const offs = [
			// The document's dirty state (RETAINED; retracted when the editor
			// closes — an undefined delivery is that retraction).
			cm.subscribe(`pipeline:doc:${doc}`, (snap) => {
				const d = snap as { isDirty?: boolean; isNew?: boolean } | undefined;
				if (!d) return;
				if (typeof d.isDirty === 'boolean') setIsDirty(d.isDirty);
				if (typeof d.isNew === 'boolean') setIsNew(d.isNew);
			}),
			// The canvas echo (undo/redo, external edits) — a SIGNAL.
			cm.subscribe(`pipeline:doc:${doc}:canvas`, (payload) => {
				const c = payload as { project?: unknown } | undefined;
				if (c?.project !== undefined) setProject(c.project);
			}),
			// OAuth tokens — retained until APPLIED; this page retracts after
			// taking them (a one-shot credential, not state) and stamps the
			// applying content change with saveAfter.
			cm.subscribe(`pipeline:doc:${doc}:oauth`, (snap) => {
				const t = snap as { tokens?: string; state?: string } | undefined;
				if (!t?.tokens || !t.state) return;
				saveAfterOAuthRef.current = true;
				setPendingOAuthTokens({ tokens: t.tokens, state: t.state });
				cm.publish(`pipeline:doc:${doc}:oauth`, undefined);
			}),
			// The host's run gate asks for the Subscribe overlay — a SIGNAL
			// (one-shot): replaying it after a later subscribe would reopen it.
			cm.subscribe(`pipeline:doc:${doc}:checkout`, (payload) => {
				if ((payload as { required?: boolean } | undefined)?.required) setShowCheckout(true);
			}),
			// Subscription state follows the MIRRORED account — the host no
			// longer pushes it (every realm can derive the same answer).
			cm.on('shell:accountUpdate', () => {
				const sub = isAppSubscribed(cm.getAccountInfo(), PIPE_BUILDER_APP_ID);
				setSubscribed(sub);
				if (sub) setShowCheckout(false);
			}),
			cm.subscribe('pipeline:env', (snap) => {
				const keys = (snap as { envKeys?: string[] } | undefined)?.envKeys;
				if (Array.isArray(keys)) envKeysApplyRef.current?.(keys);
			}),
			cm.subscribe('pipeline:cloudSetup', (snap) => {
				const v = (snap as { cloudConnectionConfigured?: boolean } | undefined)?.cloudConnectionConfigured;
				if (typeof v === 'boolean') setCloudConnectionConfigured(v);
			}),
		];
		return () => offs.forEach((off) => off());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// --- Realm plumbing this webview still owns -------------------------------

	// This realm's prefs store — the SHELL partition, mirrored off the
	// workspace manager. Grid layouts answer synchronously from it, so
	// DataGrid persistence works in this webview exactly as in the web shell.
	const shellPrefs = useMemo(() => createMirroredPrefsStore(ConnectionManager.getInstance(), SHELL_PARTITION), []);
	useGridConfigAnswering(shellPrefs.store);
	useEffect(() => shellPrefs.dispose, [shellPrefs]);

	const getStateRef = useRef<() => ViewState | null>(() => null);
	const { getState, setState } = useMessaging<PipelineWebviewToHost, PipelineHostToWebview, ViewState>({});
	useEffect(() => {
		getStateRef.current = getState;
	}, [getState]);

	// --- The host seam ---------------------------------------------------------

	const handleContentChanged = useCallback((updatedProject: unknown) => {
		setProject(updatedProject);
		const saveAfter = saveAfterOAuthRef.current;
		saveAfterOAuthRef.current = false;
		ConnectionManager.getInstance().emitOp('host.pipeline.contentSet', { doc: docRef.current, project: updatedProject, ...(saveAfter ? { saveAfter } : {}) });
	}, []);

	const handleViewStateChange = useCallback(
		(vs: ViewState) => {
			setViewState(vs);
			// Persist to VS Code webview state (survives tab switches)
			const current = getState() ?? ({} as ViewState);
			setState({ ...current, ...vs });
			ConnectionManager.getInstance().emitOp('host.pipeline.viewState', { doc: docRef.current, viewState: vs });
		},
		[getState, setState]
	);

	const editorHost = useMemo<IPipelineEditorHost>(
		() => ({
			isDirty,
			isNew,
			isReadonly,
			...(viewState ? { initialViewState: viewState } : {}),
			onViewStateChange: handleViewStateChange,
			onContentChanged: handleContentChanged,
			save: () => ConnectionManager.getInstance().emitOp('host.pipeline.save', { doc: docRef.current }),
			/** The provider owns the TextDocument; publish saves host-side —
			 *  the panel just needs a resolvable save step for its flow. */
			saveDocument: async () => {},
			/** Publish the SAVED document — the host snapshots the TextDocument;
			 *  only metadata travels. A host failure arrives as the rejection. */
			publish: async (comment: string, deployTo?: string) => {
				await ConnectionManager.getInstance().request('host.pipeline.publish', { doc: docRef.current, comment, ...(deployTo ? { deployTo } : {}) } as never);
			},
			runAction: (action, source) => {
				const cm = ConnectionManager.getInstance();
				if (action === 'stop') {
					if (source) cm.emitOp('host.pipeline.stop', { doc: docRef.current, source });
					return;
				}
				cm.emitOp('host.pipeline.run', { doc: docRef.current, action, source });
			},
			isSubscribed: subscribed,
			// The host's run gate also signals the overlay; the lock icon's own
			// click opens it directly.
			promptSubscribe: () => setShowCheckout(true),
			openLink: (url, displayName) => ConnectionManager.getInstance().emitOp('host.pipeline.openLink', { url, displayName }),
			openCloudSetup: () => {
				// Focus the Development tab only — the prompt must not stage a
				// connection-mode change the user never typed.
				ConnectionManager.getInstance().emitOp('host.openPage', { page: 'settings', args: ['development'] });
			},
			cloudConnectionConfigured,
			...(oauthReturnUrl !== undefined ? { oauthReturnUrl } : {}),
			onOpenExternal: (url) => ConnectionManager.getInstance().emitOp('host.pipeline.oauthStart', { doc: docRef.current, url }),
			...(pendingOAuthTokens !== undefined ? { pendingOAuthTokens } : {}),
			clearPendingOAuthTokens: () => setPendingOAuthTokens(undefined),
			onMissingEnvVars: (keys) => ConnectionManager.getInstance().emitOp('host.pipeline.missingEnv', { keys }),
			envKeysFeed: (apply) => {
				envKeysApplyRef.current = apply;
				return () => {
					if (envKeysApplyRef.current === apply) envKeysApplyRef.current = null;
				};
			},
		}),
		[isDirty, isNew, isReadonly, viewState, subscribed, cloudConnectionConfigured, oauthReturnUrl, pendingOAuthTokens, handleContentChanged, handleViewStateChange]
	);

	// --- Checkout callbacks — the realm client's billing surface --------------

	const needBillingClient = useCallback(() => {
		const cm = ConnectionManager.getInstance();
		const client = cm.getClient();
		if (!client || !cm.isConnected()) throw new Error('Not connected to server');
		return client;
	}, []);

	const handleFetchPlans = useCallback((): Promise<CheckoutPlan[]> => {
		return needBillingClient().billing.getProductPrices(PIPE_BUILDER_APP_ID) as Promise<CheckoutPlan[]>;
	}, [needBillingClient]);

	const handleCreateCheckout = useCallback((priceId: string): Promise<{ clientSecret: string; subscriptionId: string }> => {
		const orgId = ConnectionManager.getInstance().getAccountInfo()?.organization?.id;
		if (!orgId) return Promise.reject(new Error('No organisation found'));
		return needBillingClient().billing.createCheckoutSession(orgId, PIPE_BUILDER_APP_ID, priceId) as Promise<{ clientSecret: string; subscriptionId: string }>;
	}, [needBillingClient]);

	const handleConfirmPending = useCallback(async (subscriptionId: string, priceId: string): Promise<void> => {
		// No SDK method exists for confirm_pending; wrap the public call()
		// exactly as BillingApi wraps its other verbs.
		await needBillingClient().call('rrext_account_billing', { subcommand: 'confirm_pending', appId: PIPE_BUILDER_APP_ID, subscriptionId, priceId });
	}, [needBillingClient]);

	// --- Wait for initial state from host before rendering --------------------

	if (!viewState) return null;

	// --- Render ----------------------------------------------------------------

	return (
		<>
			<PipelineEditor project={project} host={editorHost} />
			{showCheckout && stripeKey && <CheckoutModal appName="RocketRide" appDescription="Visual AI pipeline editor: run and deploy pipelines on RocketRide Cloud." stripePublishableKey={stripeKey} onFetchPlans={handleFetchPlans} onCreateCheckout={handleCreateCheckout} onConfirmPending={handleConfirmPending} onSuccess={() => { setShowCheckout(false); setSubscribed(true); }} onClose={() => setShowCheckout(false)} onActionClick={(_plan: CheckoutPlan, action: PlanAction) => ConnectionManager.getInstance().emitOp('host.pipeline.openLink', { url: action.type === 'mailto' ? `mailto:${action.url}${action.subject ? `?subject=${encodeURIComponent(action.subject)}` : ''}` : action.url, browser: true })} />}
			{showCheckout && !stripeKey && <CheckoutUnavailableNotice reason={stripeKeyReason} onClose={() => setShowCheckout(false)} />}
		</>
	);
};

export default PipelineWebview;
