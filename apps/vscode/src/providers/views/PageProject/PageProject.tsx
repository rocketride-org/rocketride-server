// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageProject — VS Code webview entry for the pipeline editor.
 *
 * Imports CSS themes and mounts ProjectWebview, which bridges messages from
 * the extension host to the pure ProjectView component.
 */

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

export { default as PageProject } from './ProjectWebview';
