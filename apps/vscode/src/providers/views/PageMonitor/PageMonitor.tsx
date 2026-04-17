// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageMonitor — VS Code webview entry for the server monitor.
 *
 * Imports the shared MonitorPage component and adds VS Code-specific CSS.
 * Communication is handled by MonitorPage via useMessaging (VS Code path).
 */

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

export { MonitorPage as PageMonitor } from 'shared/modules/server';
