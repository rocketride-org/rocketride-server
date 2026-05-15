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
// USE APP COMPONENT — load a component from another app
// =============================================================================

import { useEffect } from 'react';
import { useWorkspace } from '../workspace/WorkspaceContext';

/**
 * Loads a React component from another app's component catalog.
 *
 * If the target app's descriptor hasn't been loaded yet, triggers a lazy
 * load automatically.  Returns `null` while loading, then the component
 * once the descriptor is available.
 *
 * @param appId         - The appId of the target app (e.g. 'rocketride.pipeBuilder').
 * @param componentName - The key in that app's `components` object (e.g. 'SpecialChart').
 * @returns The React component, or null if not yet loaded / not found.
 *
 * @example
 * ```tsx
 * const Chart = useAppComponent('rocketride.otherApp', 'SpecialChart');
 * if (!Chart) return <div>Loading...</div>;
 * return <Chart data={myData} />;
 * ```
 */
export function useAppComponent(appId: string, componentName: string): React.ComponentType<any> | null {
	const { loadedApps, loadApp } = useWorkspace();

	// Trigger lazy load if not already loaded
	useEffect(() => {
		if (!loadedApps[appId]) {
			loadApp(appId);
		}
	}, [appId, loadedApps, loadApp]);

	// Return the component if available
	return loadedApps[appId]?.components?.[componentName] ?? null;
}
