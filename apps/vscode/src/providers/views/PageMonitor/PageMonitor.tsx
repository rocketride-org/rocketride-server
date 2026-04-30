// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageMonitor — VS Code webview entry for the server monitor.
 *
 * Imports CSS themes and mounts MonitorWebview, which bridges messages from
 * the extension host to the pure ServerMonitor component.
 */

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

export { default as PageMonitor } from './MonitorWebview';
