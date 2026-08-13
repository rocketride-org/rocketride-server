/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import React from 'react';
import { createRoot } from 'react-dom/client';

import 'shell/src/themes/rocketride-default.css';
import Trace from '@app-shared/components/trace/Trace';
import { TraceDetail } from '@app-shared/components/trace/TraceDetail';
import { applyHostTheme } from './host-theme';

// Skeleton: proves the cross-package bundle. Task 4/5 replace this with the
// real list/detail wiring. The TraceDetail reference is deliberate — it keeps
// the detail tree (incl. all renderers) in the bundle for the size check.
void TraceDetail;

applyHostTheme();
const app = new App({ name: 'RocketRide trace viewer', version: '0.1.0' });
const root = createRoot(document.getElementById('root') as HTMLElement);

app.ontoolresult = () => {
	root.render(<Trace rows={[]} />);
};
app.connect().catch((err) => {
	root.render(<div className="rr-waiting">Could not connect to the MCP host: {err instanceof Error ? err.message : String(err)}</div>);
});
