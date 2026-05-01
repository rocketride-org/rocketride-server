// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageAccount — VS Code webview entry for account management.
 *
 * Imports CSS themes and mounts AccountWebview, which bridges messages from
 * the extension host to the pure AccountView component.
 */

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

export { default as PageAccount } from './AccountWebview';
