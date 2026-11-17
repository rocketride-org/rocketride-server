/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Pipeline canvas widget: draws the view_pipeline tool result read-only.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';

// Order matters: the app tokens first (the builder's components paint with
// --rr-*), then the widget design system, then the canvas chrome. There is no
// brand row: the chat host already names the app above the widget.
import 'shell/src/themes/rocketride-default.css';
import '../shared/theme.css';
import { applyHostTheme } from '../shared/host-theme';
import { CanvasApp } from './CanvasApp';
import { buildCanvasModel, type ToolResultLike } from './model';
// After CanvasApp, so it lands after the builder's canvas CSS it adjusts.
import './canvas.css';

const app = new App({ name: 'RocketRide pipeline canvas', version: '0.1.0' });
applyHostTheme(app);
const root = createRoot(document.getElementById('root') as HTMLElement);

/** Hosts that keep result metadata on `window.openai` instead of the result. */
function hostMetadata(): unknown {
	return (window as unknown as { openai?: { toolResponseMetadata?: unknown } }).openai?.toolResponseMetadata;
}

// Keyed by a counter so every tool result remounts the canvas from scratch:
// no viewport or layout from an earlier pipeline survives into the next.
let resultCount = 0;
app.ontoolresult = (result) => {
	resultCount += 1;
	root.render(<CanvasApp key={resultCount} app={app} model={buildCanvasModel(result as ToolResultLike, hostMetadata())} />);
};
app.connect().catch((err) => {
	root.render(<div className="rr-card rr-canvas-error">Could not connect to the chat host: {err instanceof Error ? err.message : String(err)}</div>);
});
