// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pipeline — VS Code webview entry for the pipeline editor.
 *
 * Imports CSS themes and re-exports PipelineWebview (the bus-realm page).
 */

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';

export { default as Pipeline } from './PipelineWebview';
