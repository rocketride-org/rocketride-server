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

/**
 * VSCode Extension Build Module
 * 
 * RocketRide extension for Visual Studio Code.
 */
const path = require('path');
const { 
    execCommand, syncDir, removeDirs, removeMatching, PROJECT_ROOT,
    hasSourceChanged, saveSourceHash, setState, exists, copyFile, readDir, mkdir, rm,
    readFile, writeFile
} = require('../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(APP_ROOT, 'src');
const SHARED_UI_SRC = path.join(PROJECT_ROOT, 'packages', 'shared-ui', 'src');

// State keys for source fingerprints (webview bundles shared-ui via Canvas)
const SRC_HASH_KEY = 'vscode.srcHash';
const BUNDLE_HASH_KEY = 'vscode.bundleHash';
const SHARED_UI_HASH_KEY = 'vscode.sharedUiHash';

// All extension build output goes here (bundle, webview, manifest for vsce and F5)
const BUILD_DIR = path.join(PROJECT_ROOT, 'build', 'vscode');
const BUILD_WEBVIEW_DIR = path.join(BUILD_DIR, 'webview');

// .vsix output directory
const VSCODE_DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'vscode');

// =============================================================================
// Helpers: change detection (vscode src + shared-ui, which webview bundles)
// =============================================================================

async function hasVscodeOrSharedUiChanged() {
    const [vscode, sharedUi] = await Promise.all([
        hasSourceChanged(SRC_DIR, SRC_HASH_KEY),
        hasSourceChanged(SHARED_UI_SRC, SHARED_UI_HASH_KEY),
    ]);
    return {
        changed: vscode.changed || sharedUi.changed,
        srcHash: vscode.hash,
        sharedUiHash: sharedUi.hash,
    };
}

async function saveVscodeAndSharedUiHashes(srcHash, sharedUiHash) {
    await saveSourceHash(SRC_HASH_KEY, srcHash);
    await saveSourceHash(SHARED_UI_HASH_KEY, sharedUiHash);
}

// =============================================================================
// Action Factories
// =============================================================================

function makeBuildWebviewAction() {
    return {
        run: async (ctx, task) => {
            const { changed, srcHash, sharedUiHash } = await hasVscodeOrSharedUiChanged();
            const outputExists = await exists(BUILD_WEBVIEW_DIR);
            
            if (!changed && outputExists) {
                task.output = 'No changes detected';
                return;
            }
            
            await execCommand('npx', ['rsbuild', 'build'], { task, cwd: APP_ROOT });
            
            await saveVscodeAndSharedUiHashes(srcHash, sharedUiHash);
        }
    };
}

function makeCompileTypescriptAction() {
    return {
        run: async (ctx, task) => {
            // Check if source changed
            const { changed, hash } = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);
            // Output goes to build/vscode/out per tsconfig.json
            const outputExists = await exists(path.join(BUILD_DIR, 'out'));
            
            if (!changed && outputExists) {
                task.output = 'No changes detected';
                return;
            }
            
            await execCommand('npx', ['tsc', '-p', './'], { task, cwd: APP_ROOT });
            
            // Save hash after successful compile
            await saveSourceHash(SRC_HASH_KEY, hash);
        }
    };
}

function makeBundleExtensionAction() {
    return {
        run: async (ctx, task) => {
            // Check if source changed (uses its own hash key so compile-typescript
            // saving SRC_HASH_KEY doesn't cause this step to skip)
            const { changed, hash } = await hasSourceChanged(SRC_DIR, BUNDLE_HASH_KEY);
            const outputExists = await exists(path.join(BUILD_DIR, 'rocketride.js'));

            if (!changed && outputExists) {
                task.output = 'No changes detected';
                return;
            }

			await execCommand('node', ['esbuild.js', '--production'], { task, cwd: APP_ROOT });

			// Save hash after successful build
			await saveSourceHash(BUNDLE_HASH_KEY, hash);
        }
    };
}

function makeStageFilesAction() {
    return {
        run: async (ctx, task) => {
            const { changed, srcHash, sharedUiHash } = await hasVscodeOrSharedUiChanged();
            const buildHasManifest = await exists(path.join(BUILD_DIR, 'package.json'));
            
            if (!changed && buildHasManifest) {
                task.output = 'No changes detected';
                return;
            }
            
            // Ensure build dir exists (bundle and webview already there from esbuild/rsbuild)
            await mkdir(BUILD_DIR);
            
            // Copy manifest and assets so build/vscode is a complete extension
            task.output = 'Staging manifest and assets to build/vscode...';
            const pkgPath = path.join(APP_ROOT, 'package.json');
            const pkg = JSON.parse(await readFile(pkgPath));
            pkg.main = './rocketride.js';
            pkg.icon = 'rocketride-dark-icon.png';
            pkg.files = ['rocketride.js', 'rocketride.js.map', 'webview/**', 'rocketride-dark-icon.png', 'rocketride-light-icon.png', 'docker.svg', 'onprem.svg', 'package.json', 'LICENSE', 'docs/**'];
            await writeFile(path.join(BUILD_DIR, 'package.json'), JSON.stringify(pkg, null, 2));
            const iconDark = path.join(APP_ROOT, 'rocketride-dark-icon.png');
            const iconLight = path.join(APP_ROOT, 'rocketride-light-icon.png');
            if (await exists(iconDark)) {
                await copyFile(iconDark, path.join(BUILD_DIR, 'rocketride-dark-icon.png'));
            }
            if (await exists(iconLight)) {
                await copyFile(iconLight, path.join(BUILD_DIR, 'rocketride-light-icon.png'));
            }
            const dockerSvg = path.join(APP_ROOT, 'docker.svg');
            const onpremSvg = path.join(APP_ROOT, 'onprem.svg');
            if (await exists(dockerSvg)) {
                await copyFile(dockerSvg, path.join(BUILD_DIR, 'docker.svg'));
            }
            if (await exists(onpremSvg)) {
                await copyFile(onpremSvg, path.join(BUILD_DIR, 'onprem.svg'));
            }
            await copyFile(path.join(PROJECT_ROOT, 'LICENSE'), path.join(BUILD_DIR, 'LICENSE'));
            const docsSrc = path.join(APP_ROOT, 'docs');
            if (await exists(docsSrc)) {
                await syncDir(docsSrc, path.join(BUILD_DIR, 'docs'));
            }

            // Write .vscodeignore so vsce excludes the engine directory (downloaded at runtime)
            await writeFile(path.join(BUILD_DIR, '.vscodeignore'), 'engine/**\n');

            await saveVscodeAndSharedUiHashes(srcHash, sharedUiHash);
            task.output = 'Manifest staged in build/vscode';
        }
    };
}

function makePackageVsixAction() {
    return {
        run: async (ctx, task) => {
            const { changed } = await hasVscodeOrSharedUiChanged();
            
            // Check if .vsix already exists
            const vsixFiles = await exists(VSCODE_DIST_DIR) 
                ? (await readDir(VSCODE_DIST_DIR)).filter(f => f.endsWith('.vsix'))
                : [];
            
            if (!changed && vsixFiles.length > 0) {
                task.output = 'No changes detected';
                return;
            }
            
            await mkdir(VSCODE_DIST_DIR);
            const vsceOut = path.relative(BUILD_DIR, VSCODE_DIST_DIR);
            await execCommand('npx', ['vsce', 'package', '--no-dependencies', '-o', vsceOut], { task, cwd: BUILD_DIR });
            
            task.output = `Package created in ${VSCODE_DIST_DIR}`;
        }
    };
}

function makeCleanStagingAction() {
    return {
        run: async (ctx, task) => {
            if (await exists(BUILD_DIR)) {
                await rm(BUILD_DIR);
            }
            task.output = 'Build directory cleaned (build/vscode)';
        }
    };
}

// =============================================================================
// Module Definition
// =============================================================================

module.exports = {
    name: 'vscode',
    description: 'RocketRide VSCode Extension',
    
    actions: [
        // Internal actions
        { name: 'vscode:build-webview', action: makeBuildWebviewAction },
        { name: 'vscode:compile-typescript', action: makeCompileTypescriptAction },
        { name: 'vscode:bundle-extension', action: makeBundleExtensionAction },
        { name: 'vscode:stage-files', action: makeStageFilesAction },
        { name: 'vscode:package-vsix', action: makePackageVsixAction },
        { name: 'vscode:clean-staging', action: makeCleanStagingAction },
        
        // Public actions (have descriptions)
        { name: 'vscode:compile', action: () => ({
            description: 'Compile VSCode extension',
            steps: [
                'client-typescript:build',
                'vscode:build-webview',
                'vscode:compile-typescript',
                'vscode:bundle-extension'
            ]
        })},
        { name: 'vscode:build', action: () => ({
            description: 'Build VSCode extension',
            steps: [
                'client-typescript:build',
                'vscode:build-webview',
                'vscode:compile-typescript',
                'vscode:bundle-extension',
                'vscode:stage-files',
                'vscode:package-vsix'
            ]
        })},
        { name: 'vscode:clean', action: () => ({
            description: 'Clean VSCode extension',
            run: async (ctx, task) => {
                await removeDirs([
                    BUILD_DIR,
                    path.join(APP_ROOT, 'dist'),
                    path.join(APP_ROOT, 'out'),
                    VSCODE_DIST_DIR
                ]);
                await removeMatching(APP_ROOT, '.vsix');
                await setState(SRC_HASH_KEY, null);
                await setState(BUNDLE_HASH_KEY, null);
                await setState(SHARED_UI_HASH_KEY, null);
                task.output = 'Cleaned vscode';
            }
        })}
    ]
};
