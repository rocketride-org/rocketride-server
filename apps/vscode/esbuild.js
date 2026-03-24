// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const buildRoot = path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? '../../build', 'vscode');
const outfile = path.join(buildRoot, 'rocketride.js');

esbuild
	.build({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: true,
		platform: 'node',
		target: 'node16',
		outfile,
		external: ['vscode'],
		alias: {
			// docker-modem requires ssh2 at load time, but we only use local socket.
			// Stub it out so no native .node binaries are needed.
			ssh2: path.resolve(__dirname, 'src/stubs/ssh2.js'),
		},
		mainFields: ['main'],
		resolveExtensions: ['.ts', '.js', '.json'],
		logLevel: 'info',
		packages: 'bundle',
		// Disable AMD detection properly
		define: {
			define: 'undefined',
		},
		loader: {
			'.json': 'json',
		},
	})
	.then(() => {
		// Copy skills/ directory to build output for agent documentation discovery
		const srcSkills = path.join(__dirname, 'skills');
		const destSkills = path.join(buildRoot, 'skills');
		if (fs.existsSync(srcSkills)) {
			fs.rmSync(destSkills, { recursive: true, force: true });
			fs.cpSync(srcSkills, destSkills, { recursive: true });
			console.log(`Copied skills/ to ${destSkills}`);
		}
	})
	.catch((error) => {
		console.error('esbuild failed:', error);
		process.exit(1);
	});
