// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * page-frame — the ONE webview bundle for every framework page.
 *
 * The devtool-frame pattern with a compile-time resolver: a generic frame
 * plus a pointer to a React component. Store tools resolve their pointer at
 * runtime via loadRemote (the engine's app registry); framework pages ship
 * with the extension, so the registry is this static import table and the
 * host injects only the PAGE NAME (a `data-rr-page` attribute stamped into
 * the served HTML by FrameworkProvider — present before any script runs, so
 * there is no handshake and no flash of the wrong page).
 *
 * Adding a framework page = write the component, add one import + one
 * registry row here, add one FrameworkProvider row in the extension. No new
 * bundle, no build config.
 */

// ── Theme CSS (order matters: default first, then VS Code overrides) ────────
import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';

import React from 'react';
import { mountComponent } from '../../../shared/util/mount';
import { attachBusRealm } from '../hooks/busRealm';
import AccountPage from '../account/AccountWebview';
import EnvironmentPage from '../environment/EnvironmentWebview';
import WelcomePage from '../welcome/WelcomeWebview';
import SettingsPage from '../settings/SettingsWebview';
import DevToolReadmePage from '../devtool-readme/DevToolReadmeWebview';
import NewAppPage from '../new-app/NewAppWebview';

// Every framework page this host can serve — THE allowlist of what mounts.
const PAGES: Record<string, React.ComponentType> = {
	account: AccountPage,
	environment: EnvironmentPage,
	welcome: WelcomePage,
	settings: SettingsPage,
	'devtool-readme': DevToolReadmePage,
	newapp: NewAppPage,
};

/** Rendered when the host names a page this bundle does not know. */
const PageNotFound: React.FC = () => (
	<div style={{ padding: 24, fontFamily: 'var(--rr-font-family)', color: 'var(--rr-text-secondary)' }}>
		Unknown framework page: <code>{document.body.dataset.rrPage ?? '(unset)'}</code>
	</div>
);

// The realm's ONE bus attachment, before anything renders.
attachBusRealm();

const page = document.body.dataset.rrPage ?? '';
mountComponent(PAGES[page] ?? PageNotFound, page || 'page-frame');
