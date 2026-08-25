// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Account — VS Code webview entry for account management.
 *
 * Imports CSS themes and mounts AccountWebview, which bridges messages from
 * the extension host to the pure AccountView component.
 */

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';

export { default as Account } from './AccountWebview';
