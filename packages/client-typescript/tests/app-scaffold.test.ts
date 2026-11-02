/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The scaffolded rsbuild config must keep failed builds out of the preview
 * (#2455): an errored compilation's hot update disposes every module only
 * the broken file imported, and the fix-apply then dies silently.
 */

import { describe, it, expect } from '@jest/globals';
import { renderTemplate, TEMPLATE_NAMES } from '../src/app-scaffold/index';

const VARS = {
	appId: 'acme.brandy',
	appName: 'Brand Studio',
	publisher: 'local',
	moduleId: 'acme_brandy',
	port: 3101,
	previewUrl: 'http://localhost:5565/?appid=acme.brandy&rrdev=1',
};

describe('app scaffold rsbuild config', () => {
	it.each(TEMPLATE_NAMES)('%s template never emits an errored build', (template) => {
		const config = renderTemplate(template, VARS).find((f) => f.path === 'rsbuild.config.mts');
		// Inside tools.rspack: rsbuild ignores a top-level optimization key
		expect(config?.content).toMatch(/rspack: \{[^}]*optimization: \{ emitOnErrors: false \}/);
	});
});
