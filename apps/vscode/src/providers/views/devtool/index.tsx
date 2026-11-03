// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Rsbuild entry point for the dev-tool webview page (its own MF-host build —
 * see rsbuild.devtool.config.mjs).
 */

// Theme CSS (order matters: default first, then the VS Code overrides that
// carry the --rr-* tokens the mounted tool styles itself with).
import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';

import DevTool from './DevToolWebview';
import { mountComponent } from '../../../shared/util/mount';
import { attachBusRealm } from '../hooks/busRealm';

// The panel is a bus realm: the tool's peer rides the retained/signal lanes
// and any engine access is request('client.*') against the broker.
attachBusRealm();

// Mount the dev-tool page into the webview DOM.
mountComponent(DevTool, 'DevTool');

export default DevTool;
