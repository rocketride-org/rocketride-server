// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Rsbuild entry point for the pipeline-editor webview page.
 */

// React globals BEFORE any shared component is evaluated: ReactFlow expects
// window.React at module-eval time. This import must stay first.
import '../setup.react';

// Theme CSS (order matters: default first, then the VS Code overrides that
// carry the --rr-* tokens, then the page root).
import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import '../../styles/root.css';

import Pipeline from './PipelineWebview';
import { mountComponent } from '../../../shared/util/mount';
import { attachBusRealm } from '../hooks/busRealm';

// The editor realm's one bus attachment — boot state, per-doc topics, and
// engine access all ride the bus.
attachBusRealm();

// Mount the pipeline view directly — it renders its own TabControl strip.
mountComponent(Pipeline, 'Pipeline');
export default Pipeline;
