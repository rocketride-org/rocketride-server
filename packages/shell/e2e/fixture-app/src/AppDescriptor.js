// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// E2E FIXTURE APP: descriptor and outcome channel
// =============================================================================
// The fixture is the "hostile" app of the Playwright suite. Every scenario
// reports what the app was able to do through `window.rrReport`, which the
// harness installs with `context.exposeBinding`, so a spec fails because an
// exploit succeeded, never because the frame or the app is missing. The
// scenario to run comes from `window.rrScenario()` (also a harness binding).
// =============================================================================

import React from 'react';
import * as shell from 'shell';
import { runScenario } from './scenarios.js';

/* global __E2E_APP_ID__ */
const APP_ID = __E2E_APP_ID__;
const IS_HOME = APP_ID === 'rocketride.hello';

/** Sends one outcome to the harness (a no-op without the binding). */
export function report(kind, data) {
	try {
		const fn = window.rrReport;
		if (typeof fn === 'function') void fn({ kind, origin: location.origin, framed: window !== window.top, ...data });
	} catch {
		/* the harness is gone */
	}
}

// Module evaluation is itself an outcome: X9 asserts it never happens in the shell realm.
// (The home build is the platform's own app in the shell realm; it only reports its helpers.)
if (!IS_HOME) report('module-executed', {});

/**
 * Home build only: the helpers the specs use to drive the shell's own flows from
 * outside its chrome (the harness has no sidebar to click). They emit the same
 * events the chrome does, so `handleLogout` and the app switch run unchanged.
 */
if (IS_HOME) {
	const cm = shell.ConnectionManager.getInstance();
	window.__e2e = {
		logout: () => cm.emit('shell:logoutRequest', undefined),
		switchApp: (appId) => cm.emit('shell:switchApp', { appId }),
		// What the version picker does: store the override (and drop the cached descriptor).
		setVersion: (appId, moduleId, version) => shell.applyAppVersionOverride(appId, moduleId, version === null ? null : { version }),
	};
}

function FixtureApp(props) {
	const started = React.useRef(false);
	React.useEffect(() => {
		if (IS_HOME || started.current) return;
		started.current = true;
		void (async () => {
			let config = { scenario: 'l1', params: {} };
			try {
				if (typeof window.rrScenario === 'function') config = (await window.rrScenario()) || config;
			} catch {
				/* the default scenario */
			}
			try {
				await runScenario(config.scenario, config.params || {}, props, report);
			} catch (err) {
				report('scenario-error', { scenario: config.scenario, error: String((err && err.message) || err) });
			}
		})();
	}, []);
	return React.createElement('div', { 'data-testid': 'fixture-root', style: { padding: 16, fontFamily: 'sans-serif' } }, React.createElement('h1', { 'data-testid': 'fixture-title' }, IS_HOME ? 'E2E home' : 'E2E fixture app'), React.createElement('p', { 'data-testid': 'fixture-connected' }, props.isConnected ? 'connected' : 'disconnected'), React.createElement('p', { 'data-testid': 'fixture-user' }, props.identity ? String(props.identity.userId) : 'no identity'));
}

const descriptor = {
	id: APP_ID,
	name: 'E2E Fixture',
	branding: { appName: 'E2E Fixture' },
	app: FixtureApp,
};

export default descriptor;
