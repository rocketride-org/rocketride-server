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

// =============================================================================
// GUEST SHELL MODULE — what `import ... from 'shell'` resolves to inside an
// isolated app frame (PR2b, plan §3.4)
// =============================================================================
//
// The whole public surface of `../api`, with the Appendix A names shadowed:
// each throws `CapabilityDeniedError` when called or constructed (and is
// denied on `shellApi` too). `getIsolation()` is `null` (a guest is never the
// isolation host). `getClient`/`ConnectionManager` are this realm's own
// objects: the guest ConnectionManager in guest mode, with its brokered client.
// =============================================================================

import * as api from '../api';
import type { ShellApiShape } from '../api';
import { CapabilityDeniedError } from '../isolation/capabilityDenied';

export * from '../api';

/** A value that refuses every use in a guest. */
function deniedValue<T>(name: string): T {
	const refuse = function (): never {
		throw new CapabilityDeniedError(`${name}: denied (capability)`, { code: 'capability', op: name });
	};
	return refuse as unknown as T;
}

export const CloudAuthProvider = deniedValue<typeof api.CloudAuthProvider>('CloudAuthProvider');
export const ApiKeyAuthProvider = deniedValue<typeof api.ApiKeyAuthProvider>('ApiKeyAuthProvider');
export const AccountProvider = deniedValue<typeof api.AccountProvider>('AccountProvider');
export const useShellApiKey = deniedValue<typeof api.useShellApiKey>('useShellApiKey');
export const CheckoutFlow = deniedValue<typeof api.CheckoutFlow>('CheckoutFlow');
export const AccountView = deniedValue<typeof api.AccountView>('AccountView');
export const useIframeBridge = deniedValue<typeof api.useIframeBridge>('useIframeBridge');
export const createBusRouter = deniedValue<typeof api.createBusRouter>('createBusRouter');
export const attachRealmToRoot = deniedValue<typeof api.attachRealmToRoot>('attachRealmToRoot');
export const registerClientOps = deniedValue<typeof api.registerClientOps>('registerClientOps');
export const applyAppVersionOverride = deniedValue<typeof api.applyAppVersionOverride>('applyAppVersionOverride');

/** A guest is never the isolation host. */
export const getIsolation: typeof api.getIsolation = () => null;

const SHADOWED: Record<string, unknown> = {
	CloudAuthProvider,
	ApiKeyAuthProvider,
	AccountProvider,
	useShellApiKey,
	CheckoutFlow,
	AccountView,
	useIframeBridge,
	createBusRouter,
	attachRealmToRoot,
	registerClientOps,
	applyAppVersionOverride,
	getIsolation,
};

/** The guest's `shellApi`: the real members' getters, the shadowed names replaced. */
export const shellApi: ShellApiShape = (() => {
	const out = {} as Record<string, unknown>;
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(api.shellApi))) {
		if (key in SHADOWED) Object.defineProperty(out, key, { get: () => SHADOWED[key], enumerable: true });
		else Object.defineProperty(out, key, descriptor);
	}
	return out as unknown as ShellApiShape;
})();

/** Type conformance: the guest object is the shell API shape. */
const _check: ShellApiShape = shellApi;
void _check;

/** The guest's API object. */
export function getShellApi(): ShellApiShape {
	return shellApi;
}
