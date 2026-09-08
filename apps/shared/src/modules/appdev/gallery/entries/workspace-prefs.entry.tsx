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
// WORKSPACE & PREFS — GALLERY ENTRY (DOC-ONLY, HOOKS)
// =============================================================================

/** Doc-only gallery entry for the workspace context and the prefs accessor. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Workspace & prefs gallery entry. */
export const workspacePrefsEntry: IGalleryEntry = {
	id: 'workspace-prefs',
	name: 'Workspace & prefs',
	group: 'hooks',
	blurb: 'Per-app persisted state: useWorkspace for the full workspace context (prefs, appState, settings, app switching) and usePrefs for the minimal get/set accessor.',
	doc: `Two layers, one file behind them:

- **\`usePrefs()\`** — the small surface most components want: \`getPref(key)\` / \`setPref(key, value)\` against the active app's prefs bag. It is the ONE prefs API every app and shared surface reads and writes through; with no provider mounted it degrades to a no-op accessor.
- **\`useWorkspace()\`** — the full context: \`prefs\`/\`updatePrefs\`, the opaque \`appState\` + \`updateAppState\` pair (what \`Documents\` persists through), effective \`settings\` with \`updateSetting\` (delta-only against declared defaults), the app manifest with lazy descriptor loading, theme switching, and the workspace event bus. Throws outside its provider.

\`WorkspaceProvider\` / \`PrefsProvider\` are host bootstrap — hosted apps already live inside them.`,
	docNote: 'Prefs are per-app and workspace-persisted - store view state (selected tab, collapsed sections), not data. Data lives on the server.',
	code: `import { usePrefs, useWorkspace } from 'shell';

// The minimal accessor - view state that should survive a reload:
function CollapsibleSection() {
	const { getPref, setPref } = usePrefs();
	const open = getPref('runs.sectionOpen') !== false;
	return <Section label="Runs" onToggle={() => setPref('runs.sectionOpen', !open)} />;
}

// The full context - settings, app state, app switching:
const { settings, updateSetting, appState, updateAppState, activeAppId } = useWorkspace();`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'usePrefs', type: '() => IPrefsApi', dir: 'out', note: 'The ambient { getPref, setPref } accessor; no-op without a provider.' },
		{ name: 'useWorkspace', type: '() => IWorkspaceContext', dir: 'out', note: 'The full workspace context; throws outside WorkspaceProvider.' },
	],
	sections: [
		{
			label: 'IWorkspaceContext (key members)',
			rows: [
				{ name: 'prefs / updatePrefs', type: 'WorkspacePrefs / (patch) => void', dir: 'in', note: "The active app's prefs bag and its patch writer." },
				{ name: 'appState / updateAppState', type: 'Record<string, unknown> / (updater) => void', dir: 'in', note: 'Opaque app-owned state with a functional updater - the Documents persistence binding.' },
				{ name: 'settings / settingsOverrides / updateSetting', type: 'Record<string, SettingValue> / ... / (key, value?) => void', dir: 'in', note: 'Effective settings (defaults + overrides), the raw deltas, and the delta-only writer (default value deletes the override).' },
				{ name: 'activeAppId / appManifest / loadedApps', type: 'string / AppManifestEntry[] / Record<string, AppDescriptor>', dir: 'in', note: 'The active app plus the manifest and lazily-loaded descriptors.' },
				{ name: 'loadApp / retryApp / invalidateApp', type: '(appId) => void | Promise<boolean>', dir: 'in', note: 'Trigger, retry, or evict a lazy descriptor load.' },
				{ name: 'themeOptions / setTheme', type: '{ id, name }[] / (themeId) => void', dir: 'in', note: 'Available themes and the switcher.' },
				{ name: 'emit / on', type: '(event, payload) / (event, handler) => unsubscribe', dir: 'in', note: 'The workspace event bus (typed over ShellEventMap, plus open-set strings).' },
				{ name: 'loaded / seeded / appLoading', type: 'boolean', dir: 'out', note: 'Lifecycle flags: initial disk load done, pre-auth defaults seeded, active descriptor loading.' },
			],
		},
		{
			label: 'Providers (host bootstrap only)',
			rows: [
				{ name: 'WorkspaceProvider', type: '{ apps, workspaceDir?, startupAppId?, defaultAppId?, themeOptions?, onThemeChange? }', dir: 'in', note: 'Provides the workspace context; sources its connection from useShellConnection.' },
				{ name: 'PrefsProvider', type: '{ value: IPrefsApi }', dir: 'in', note: 'Mounts the ambient prefs accessor - once per host.' },
			],
		},
		{
			label: 'Types',
			rows: [
				{ name: 'IPrefsApi', type: '{ getPref(key) => unknown, setPref(key, value) => void }', dir: 'in', note: 'The minimal prefs contract; writes shallow-merge into the bag.' },
			],
		},
	],
};
