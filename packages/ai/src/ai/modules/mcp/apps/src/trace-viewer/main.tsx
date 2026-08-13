/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';

import 'shell/src/themes/rocketride-default.css';
import { applyHostTheme } from './host-theme';
import { TraceViewerApp } from './TraceViewerApp';

applyHostTheme();
const app = new App({ name: 'RocketRide trace viewer', version: '0.1.0' });
const root = createRoot(document.getElementById('root') as HTMLElement);

app.ontoolresult = (result) => {
	root.render(<TraceViewerApp app={app} initialResult={result} />);
};
app.connect().catch((err) => {
	root.render(<div className="rr-waiting">Could not connect to the MCP host: {err instanceof Error ? err.message : String(err)}</div>);
});
