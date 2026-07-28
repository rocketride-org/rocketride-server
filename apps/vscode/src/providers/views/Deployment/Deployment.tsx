// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Deployment — VS Code webview entry for the file-less deployment tab.
 *
 * Imports CSS themes and mounts DeploymentWebview, which bridges messages
 * from the extension host to the pure shared-ui DeploymentView component.
 */

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

export { default as Deployment } from './DeploymentWebview';
