// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageProject — VS Code webview entry for the pipeline editor.
 *
 * Imports the shared ProjectPage component and adds VS Code-specific CSS.
 * Communication is handled by ProjectPage via useMessaging (VS Code path).
 */

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

export { ProjectPage as PageProject } from 'shared/modules/project';
