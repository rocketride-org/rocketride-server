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
// AGENT GUIDES — the RocketRide agent docs, bundled into rocket-ui
// =============================================================================

/**
 * Bundles docs/agents at build time and serves it as the agent's guides.
 * rocket-ui's rsbuild loads `.md` as source text, so each guide is a lazy
 * chunk that resolves to the file's text. The bundling lives here,
 * not in shared, because shared's test runner and the VS Code build have no
 * `.md` rule. Which bundle files are guides, and where they appear, is
 * guidePathFor's rule (shared, where it is tested).
 */

import type { GuideSource } from 'shared/modules/agent/host';
import { guidePathFor } from 'shared/modules/agent/guides';

// =============================================================================
// GUIDE SOURCE
// =============================================================================

/**
 * Builds the guide source over the bundled docs/agents folder. The guide
 * paths are computed once here, so paths() stays cheap on every listing.
 *
 * @returns The guides, by path relative to '.rocketride/'.
 */
export function createRocketGuideSource(): GuideSource {
	const bundle = import.meta.webpackContext('../../../../docs/agents', { recursive: true, regExp: /\.md$/, mode: 'lazy' });

	// step: guide path -> bundle key; files that are not guides drop out
	const keys = new Map<string, string>();
	for (const key of bundle.keys()) {
		const path = guidePathFor(key);
		if (path) keys.set(path, key);
	}
	const paths = [...keys.keys()];

	return {
		paths: () => paths.slice(),
		read: async (path) => {
			const noGuide = () => new Error(`No guide at .rocketride/${path}. List .rocketride/ to see the guides.`);
			const key = keys.get(path);
			if (!key) throw noGuide();
			// step: rspack resolves an asset/source module to its text itself; a toolchain that wraps it as { default } still works
			const loaded = await bundle<Promise<unknown>>(key);
			if (typeof loaded === 'string') return loaded;
			const wrapped = (loaded as { default?: unknown } | null)?.default;
			if (typeof wrapped === 'string') return wrapped;
			throw noGuide();
		},
	};
}
