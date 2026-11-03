// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// HOST OPS — the `host.*` ops the SHELL serves, and their hooks
// =============================================================================
//
// WHERE THE host.* NAMESPACE LIVES, since it is split by layer and the split
// is not obvious:
//
//   - THIS FILE — ops the shell itself serves at EVERY framework root,
//     registered on one line in `Shell.tsx` beside `registerClientOps`.
//     These exist because the capability is the SHELL's (it owns the
//     connection and the client), and because their hooks are contract
//     surface: a hook that only answered in hosts which remembered to
//     register would be a contract the shell cannot keep.
//   - `apps/shared/src/ops/hostOps.ts` — the ops the HOST APP owns, where
//     `HostOpMap` declares the vocabulary and each host implements it
//     (`apps/rocket-ui/src/ops/hostOps.ts`, `apps/vscode/src/ops/hostOps.ts`).
//
// The two cannot be one file: `packages/shell` is BELOW `shared` and imports
// nothing from it, so `HostOpMap` is not reachable from here. Ops declared in
// this file are therefore declared locally — the same rule prefsHost.ts
// follows for its `shell.*` pair.
//
// A host may always pre-register its own handler for anything here; the bus
// skips a shared registration when one already exists (specific before
// shared), so these are defaults, not mandates.
// =============================================================================

// ── host.apiKey — the one credential a realm must ask for, not read ──────────
//
// WHY A HOOK AND NOT AN ACCESSOR: the SDK's `getApiKey()` is SYNCHRONOUS
// (`client.ts:3290`, `(): string | undefined`), and a bus round trip cannot
// satisfy a synchronous signature. Making it async would be a breaking SDK
// change, and the signature is frozen into the shell contract back to v0.
//
// WHY NOT MIRROR THE VALUE INSTEAD: that would preserve the signature at the
// cost of putting the raw credential in every webview, which is exactly what
// the VS Code host avoids today by keeping it in the extension process. A
// realm that genuinely needs the key should have to ask, visibly, at the call
// site — which is what a separately-named hook gives and a silent accessor
// does not.
//
// WHY `host.*` AND NOT `client.*`: a credential is host property, not engine
// data. The engine never sees this request.

import { useEffect, useState } from 'react';
import { ConnectionManager } from '../connection/connection';
import { registerOpHandlers } from './busOps';
import type { OpImplTable, ShellOpMap, ShellOpSpec } from './busOps';

/** The shell-served host ops, declared locally (see the header). */
interface ShellHostOpMap extends ShellOpMap {
	/** The root's API key, or null when it holds none (token auth, or not
	 *  connected). Null is an ANSWER; a rejection means "could not ask". */
	'host.apiKey': ShellOpSpec<Record<string, never>, { apiKey: string | null }>;
	/** Where Stripe sends the browser back from a portal/checkout session —
	 *  HOST POLICY, because a webview realm's own origin is never a valid
	 *  return target. The shell's default is its own page URL (right for the
	 *  cloud root); hosts without a web origin (VS Code) pre-register their
	 *  own handler. Callers pass the result into the SDK's billing methods
	 *  (`createPortalSession`/`createCreditCheckout`). */
	'host.stripeReturnUrl': ShellOpSpec<Record<string, never>, { url: string }>;
}

/** What {@link useShellApiKey} returns. */
export interface ShellApiKeyState {
	/** The key, or null — both once `loading` is false. */
	apiKey: string | null;
	/** True until the first answer (or failure) arrives. */
	loading: boolean;
	/** Why the request failed, or null. */
	error: string | null;
}

/**
 * Serves the shell's own `host.*` ops — ROOT ONLY, one call.
 *
 * Deliberately a table rather than an op-per-function: the next shell-served
 * host op should be an entry here, not another registration line at the
 * bootstrap. A host that owns one of these differently (VS Code keeps the
 * credential in its ConfigManager, not the client) registers its handler
 * FIRST and this yields, per the bus's specific-before-shared rule.
 *
 * @param bus - The root's op bus.
 * @param source - The root's client accessor.
 * @returns Unregister-all function.
 */
export function registerShellHostOps(bus: Parameters<typeof registerOpHandlers>[0], source: { getClient(): { getApiKey?(): string | undefined } | null }): () => void {
	const impls: OpImplTable<ShellHostOpMap> = {
		'host.apiKey': () => ({ apiKey: source.getClient()?.getApiKey?.() ?? null }),
		'host.stripeReturnUrl': () => ({ url: `${window.location.origin}${window.location.pathname}` }),
	};
	return registerOpHandlers<ShellHostOpMap>(bus, impls);
}

/**
 * Fetches the connection's API key, from any realm.
 *
 * The deliberate replacement for `client.getApiKey()`, which throws in a
 * realm (see RocketRideClientProxy). Use it only when the credential itself
 * is needed — to hand to a non-SDK HTTP call, or to pass into a preview
 * frame. Engine work needs no key: the client already carries the session.
 *
 * @returns The key, with its loading and failure states.
 *
 * @example
 * ```tsx
 * const { apiKey, loading } = useShellApiKey();
 * if (loading) return <Spinner />;           // NOT "no key" — unknown yet
 * ```
 */
export function useShellApiKey(): ShellApiKeyState {
	const [state, setState] = useState<ShellApiKeyState>({ apiKey: null, loading: true, error: null });

	useEffect(() => {
		let live = true;
		ConnectionManager.getInstance()
			.request('host.apiKey', {})
			.then((result) => {
				if (!live) return;
				const { apiKey } = (result ?? {}) as { apiKey?: string | null };
				setState({ apiKey: apiKey ?? null, loading: false, error: null });
			})
			.catch((err: unknown) => {
				if (!live) return;
				// A failure is reported, never collapsed into "no key": a
				// caller that cannot tell the two apart will silently take
				// the unauthenticated path.
				setState({ apiKey: null, loading: false, error: err instanceof Error ? err.message : String(err) });
			});
		return () => {
			live = false;
		};
	}, []);

	return state;
}
