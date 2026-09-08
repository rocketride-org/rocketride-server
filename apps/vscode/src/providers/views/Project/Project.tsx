// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Project — VS Code webview entry for the pipeline editor.
 *
 * Imports CSS themes and mounts ProjectWebview, which bridges messages from
 * the extension host to the pure ProjectView component.
 */

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';

export { default as Project } from './ProjectWebview';
