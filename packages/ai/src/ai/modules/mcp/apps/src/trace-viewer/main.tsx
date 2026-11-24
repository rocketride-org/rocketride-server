/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';

// Order matters: the app tokens supply everything the shared trace tree
// paints with (--rr-text-*, --rr-bg-*, --rr-chart-*), then the widget
// design-system lands on top so this widget's chrome — header, cards,
// buttons — matches the dropper and pipelines-table. The two files overlap
// on exactly one token (--rr-accent), which only the chrome reads.
import 'shell/src/themes/rocketride-default.css';
import '../shared/theme.css';
import { mountBrandHeader } from '../shared/brand';
import { applyHostTheme } from '../shared/host-theme';
import { TraceViewerApp } from './TraceViewerApp';

const app = new App({ name: 'RocketRide trace viewer', version: '0.1.0' });
applyHostTheme(app);
mountBrandHeader('RocketRide Trace');
const root = createRoot(document.getElementById('root') as HTMLElement);

// Keyed by an incrementing counter so each tool result remounts
// TraceViewerApp from scratch — otherwise its `selected` state (e.g. a
// previously-open trace id) would survive into an unrelated result.
let resultCount = 0;
app.ontoolresult = (result) => {
	resultCount += 1;
	root.render(<TraceViewerApp key={resultCount} app={app} initialResult={result} />);
};
// applyHostTheme also applies the theme from the initialize reply once
// connect() resolves, so nothing theme-related is needed here.
app.connect().catch((err) => {
	root.render(<p className="rr-message rr-message-error">Could not connect to the MCP host.</p>);
	console.error('connect failed', err);
});
