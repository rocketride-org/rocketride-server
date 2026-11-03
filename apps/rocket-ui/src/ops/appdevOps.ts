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
// APPDEV OPS — the cloud host's app-scaffold implementations
// =============================================================================
//
// The vocabulary is declared in shared/ops/appdevOps.ts; this host scaffolds
// into the STORE VFS (the .appdev tree) through the preview machinery
// (surfaces/preview — this host's implementation of the "preview an
// under-development app" capability), and swaps the untitled wizard
// document for the new app's builder. The VS Code twin lives in
// apps/vscode/src/ops/appdevOps.ts and scaffolds into the open workspace;
// the WIZARD consumes both through the one bus host
// (shared createBusNewAppWizardHost) and cannot tell them apart.
// =============================================================================

import { ConnectionManager, registerOpHandlers } from 'shell';
import type { OpImplTable } from 'shell';
import type { AppDevOpMap } from 'shared/ops/appdevOps';
import type { NewAppIdentity } from 'shared/tools/appdev/types';
import { getDocs } from '../docs';
import { listAppFolders, scaffoldApp } from '../surfaces/preview/session/appStore';

/** The developer id applied when the org has none or the connection is local/offline. */
const DEFAULT_DEVELOPER_ID = 'local';

/** The untitled (unbound) builder's document key under the apps tool. */
const WIZARD_DOC = 'tool:apps/newapp';

/**
 * Registers the app-scaffold ops and the identity change feed on the
 * framework root's bus. Idempotent per page — call once from the host app's
 * module scope, beside registerRocketHostOps.
 */
export function registerRocketAppDevOps(): () => void {
	const cm = ConnectionManager.getInstance();

	/** Resolves the developer id from the connected server's account info. */
	const resolveDeveloperId = (): { developerId: string; source: 'organization' | 'default' } => {
		const developerId = cm.isConnected() ? cm.getClient()?.getAccountInfo()?.organization?.developerId : undefined;
		return developerId ? { developerId, source: 'organization' } : { developerId: DEFAULT_DEVELOPER_ID, source: 'default' };
	};

	const buildIdentity = async (): Promise<NewAppIdentity> => {
		// Disconnected: no store to scaffold into — the form renders its
		// no-target note (workspaceOpen false).
		if (!cm.isConnected()) {
			return { developerId: DEFAULT_DEVELOPER_ID, source: 'default', workspaceOpen: false, existingFolders: [] };
		}
		const { developerId, source } = resolveDeveloperId();
		return { developerId, source, workspaceOpen: true, existingFolders: await listAppFolders() };
	};

	const impls: OpImplTable<AppDevOpMap> = {
		'host.appdev.identity': () => buildIdentity(),
		'host.appdev.scaffold': async (p) => {
			// Resolve the developer id NOW — the wizard is modeless, so the
			// form may have been open across a login/logout.
			if (!cm.isConnected()) throw new Error('Not connected to server');
			const publisher = resolveDeveloperId().developerId;
			const { appId } = await scaffoldApp({ appName: p.appName, displayName: p.displayName, publisher, frame: p.frame });
			// The sidebar re-scans off the scaffold's own onFsChange bus
			// notifications (emitFsChange inside scaffoldApp). The untitled
			// document retires and the new app's builder opens in its place.
			const docs = getDocs();
			docs?.discardDocument(WIZARD_DOC);
			docs?.openStaticDocument(`tool:apps/${appId}`, p.displayName);
		},
		'host.appdev.closeWizard': async () => {
			getDocs()?.discardDocument(WIZARD_DOC);
		},
	};
	const off = registerOpHandlers<AppDevOpMap>(cm.ops(), impls);

	// A login/logout while the modeless wizard sits open changes the linkage
	// name — push the fresh identity (best effort; the form re-pulls on mount).
	const push = (): void => {
		void buildIdentity().then(
			(identity) => cm.emitOp('host.appdev.identityChanged', identity),
			() => { /* best effort */ },
		);
	};
	const offStatus = cm.on('shell:statusChange', push);
	const offAccount = cm.on('shell:accountUpdate', push);

	return () => {
		off();
		offStatus();
		offAccount();
	};
}
