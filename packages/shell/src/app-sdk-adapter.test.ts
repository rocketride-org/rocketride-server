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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Regression coverage for the rocketride/app-sdk host-side federation adapter.
 *
 * The gap this guards against: rocketride/app-sdk (packages/client-typescript)
 * ships declaration-only stubs that throw when invoked directly - a real app
 * is only supposed to see them if Module Federation's shared-singleton
 * mechanism failed to substitute the host's real implementation. That
 * substitution requires BOTH sides to register the exact same share key
 * ('rocketride/app-sdk' is a distinct key from 'rocketride' - MF matches
 * share keys by exact string). This suite checks both halves of that
 * contract from the host side:
 *
 *  1. app-sdk-adapter.ts's export surface is a complete, real implementation
 *     - not an accidental re-export of the SDK's own throwing stubs - for
 *     every name rocketride/app-sdk declares, so a new SDK export can never
 *     silently ship without a matching host adapter.
 *  2. rsbuild.config.mts actually registers 'rocketride/app-sdk' (the exact
 *     key, not just 'rocketride') as a shared module pointing at this
 *     adapter, so the registration itself can't silently regress either.
 *
 * What this suite does NOT do: spin up two real rsbuild/rspack dev servers
 * and negotiate Module Federation shares over the network in a browser. No
 * such harness exists anywhere in this monorepo today, and building one from
 * scratch is a much larger undertaking than this fix - this instead verifies
 * the same outcome (a remote sharing this exact key would receive working,
 * non-throwing behavior) by exercising the adapter's actual runtime exports
 * directly, the same values MF would inject into a remote's module registry
 * verbatim. React hooks (useShellConnection, useWorkspace, etc.) can't be
 * invoked outside a component render, so those are checked for identity and
 * shape only; the plain-value exports (connectionManager, getDebugLog,
 * clearDebugLog, onAny, getClient, Documents) are actually invoked.
 */

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as adapter from './app-sdk-adapter';
import * as appSdkStubs from '../../client-typescript/src/app-sdk/index';
import { Documents } from './app-sdk-adapter';
import { connectionManager, getDebugLog, clearDebugLog, onAny } from './app-sdk-adapter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The full documented rocketride/app-sdk surface (mirrors app-sdk/index.ts's
// `export type { ... }` / `export declare ...` list). Kept as a literal list,
// not derived from the stub module's own keys, so a name typo'd on BOTH sides
// still fails loudly instead of trivially agreeing with itself.
const APP_SDK_VALUE_EXPORTS = ['useShellConnection', 'useShellApiConfig', 'useWorkspace', 'useAuthUser', 'useLogout', 'useSubscriptions', 'Documents', 'connectionManager', 'getDebugLog', 'clearDebugLog', 'onAny', 'useAppComponent', 'getClient'] as const;

test('app-sdk-adapter exports every documented rocketride/app-sdk value', () => {
	for (const name of APP_SDK_VALUE_EXPORTS) {
		assert.ok(name in adapter, `app-sdk-adapter.ts is missing '${name}' - a real app sharing 'rocketride/app-sdk' ` + 'would get this from its OWN bundled stub (which throws) instead of the host');
	}
});

test("app-sdk-adapter never re-exports the SDK package's own throwing stubs", () => {
	for (const name of APP_SDK_VALUE_EXPORTS) {
		const adapterValue = (adapter as Record<string, unknown>)[name];
		const stubValue = (appSdkStubs as Record<string, unknown>)[name];
		assert.notStrictEqual(adapterValue, stubValue, `app-sdk-adapter.${name} is literally the same function/object as the SDK's own stub - ` + 'a remote that received this "real" implementation would still hit shellHostRequired()');
	}
});

test('connectionManager wraps the live ConnectionManager singleton, not a throwing stub', () => {
	// These are plain functions (no React hook internals), so - unlike
	// useShellConnection/useWorkspace/etc. - they can be invoked directly here.
	assert.equal(typeof connectionManager.isConnected(), 'boolean');
	assert.equal(connectionManager.getClient(), null); // no live connection in this test process
	const unsubscribe = connectionManager.on('shell:connected', () => {});
	assert.equal(typeof unsubscribe, 'function');
	unsubscribe();
});

test('getDebugLog/clearDebugLog/onAny wrap the live singleton and never throw', () => {
	assert.ok(Array.isArray(getDebugLog()));
	assert.doesNotThrow(() => clearDebugLog());
	const unsubscribe = onAny(() => {});
	assert.equal(typeof unsubscribe, 'function');
	unsubscribe();
});

test('Documents constructs without a shell host and exposes non-hook methods', () => {
	const docs = new Documents();
	assert.equal(typeof docs.getState, 'function');
	assert.doesNotThrow(() => docs.getState());
	// useStore() is a React hook (subscribes via useSyncExternalStore) and is
	// intentionally not called here - it cannot run outside a component render.
});

test('getClient() is callable directly and does not throw shellHostRequired', () => {
	assert.doesNotThrow(() => adapter.getClient());
});

test("rsbuild.config.mts registers the exact 'rocketride/app-sdk' share key", () => {
	const configSource = fs.readFileSync(path.join(__dirname, '..', 'rsbuild.config.mts'), 'utf8');

	// Exact-string check, not a substring of 'rocketride' - MF share keys
	// match verbatim, so 'rocketride/app-sdk' quoted in the shared block is
	// the only thing that actually wires this up.
	assert.match(configSource, /['"]rocketride\/app-sdk['"]\s*:\s*\{[^}]*singleton:\s*true/, "rsbuild.config.mts's MF `shared` block no longer registers 'rocketride/app-sdk' as a singleton " + 'share - a remote sharing this key would fall back to its own bundled (throwing) copy');
	assert.match(configSource, /['"]rocketride\/app-sdk['"]\s*:\s*\{[^}]*import:\s*path\.resolve\([^)]*app-sdk-adapter/, "rsbuild.config.mts's 'rocketride/app-sdk' share entry no longer points its `import` at app-sdk-adapter.ts");
});
