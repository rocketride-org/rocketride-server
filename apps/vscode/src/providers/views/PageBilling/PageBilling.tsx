// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageBilling — VS Code webview entry for billing management.
 *
 * Imports CSS themes and mounts BillingWebview, which bridges messages from
 * the extension host to the pure BillingView component.
 */

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

export { default as PageBilling } from './BillingWebview';
