/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';

// Order matters: the app tokens supply everything the shared trace tree
// paints with (--rr-text-*, --rr-bg-*, --rr-chart-*), then the widget
// design-system lands on top so this widget's chrome — header, cards,
// buttons — matches the dropper and pipelines-table. The two files overlap
// on exactly one token (--rr-accent), which only the chrome reads.
import 'shell/src/themes/rocketride-default.css';
import '../shared/theme.css';
import { mountBrandHeader } from '../shared/brand';
import { applyHostTheme } from './host-theme';
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
app
	.connect()
	.then(() => {
		// getHostContext() only resolves post-handshake; hostcontextchanged
		// (wired in applyHostTheme) covers theme changes after this point.
		const theme = app.getHostContext()?.theme;
		if (theme) applyDocumentTheme(theme);
	})
	.catch((err) => {
		root.render(<div className="rr-waiting">Could not connect to the MCP host: {err instanceof Error ? err.message : String(err)}</div>);
	});
