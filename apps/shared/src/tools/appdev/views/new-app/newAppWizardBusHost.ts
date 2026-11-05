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
// NEW APP WIZARD — the ONE bus-backed host (every host, one transport)
// =============================================================================
//
// The wizard's host seam over the `host.appdev.*` op vocabulary
// (shared/ops/appdevOps.ts). Both hosts SERVE those ops — the VS Code
// extension host over its workspace scaffolder, the cloud host's root realm
// over the store-VFS preview machinery — so the wizard needs exactly one
// consumer-side implementation: this one. A host contributes only its
// op server and its phrasing (location prefix, missing-target note).
// =============================================================================

import { ConnectionManager } from 'shell';
import type { NewAppIdentity } from '../../types';
import type { INewAppWizardHost } from './NewAppWizard';

/** Host-phrased wizard strings (the transport is identical everywhere). */
export interface INewAppWizardBusHostOptions {
	/** Scaffold location prefix for the identity summary (e.g. 'apps/'). */
	locationPrefix?: string;
	/** Footer note when identity.workspaceOpen is false. */
	noWorkspaceNote?: string;
}

/**
 * Builds the wizard's host over this realm's bus (the `host.appdev.*` ops).
 *
 * @param options - The mounting host's phrasing, if any.
 * @returns The wizard host.
 */
export function createBusNewAppWizardHost(options?: INewAppWizardBusHostOptions): INewAppWizardHost {
	const cm = ConnectionManager.getInstance();
	return {
		identity: () => cm.request('host.appdev.identity', {} as never) as Promise<NewAppIdentity>,
		onIdentityChanged: (cb) => cm.handle('host.appdev.identityChanged', (p) => cb(p as NewAppIdentity)),
		scaffold: (appName, displayName, frame) =>
			cm.request('host.appdev.scaffold', { appName, displayName, frame } as never).then(() => undefined),
		cancel: () => cm.emitOp('host.appdev.closeWizard', {}),
		...(options?.locationPrefix !== undefined ? { locationPrefix: options.locationPrefix } : {}),
		...(options?.noWorkspaceNote !== undefined ? { noWorkspaceNote: options.noWorkspaceNote } : {}),
	};
}
