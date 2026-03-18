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
 * vcpkg Build Module
 * 
 * Handles downloading and bootstrapping vcpkg.
 */
const path = require('path');
const {
    withLock, getState, setState,
    execCommand, removeDirs, PROJECT_ROOT, BUILD_ROOT,
    exists, readJson, mkdir
} = require('../../../scripts/lib');

// Paths
const VCPKG_DIR = path.join(BUILD_ROOT, 'vcpkg');
const VCPKG_INSTALLED_DIR = path.join(BUILD_ROOT, 'vcpkg_installed');

// Read vcpkg version from package.json (loaded async in tasks)
let VCPKG_VERSION = null;

async function getVcpkgVersion() {
    if (!VCPKG_VERSION) {
        const packageJson = await readJson(path.join(PROJECT_ROOT, 'package.json'));
        VCPKG_VERSION = packageJson.vcpkg?.version || '2024.11.16';
    }
    return VCPKG_VERSION;
}

const VCPKG_REPO = 'https://github.com/microsoft/vcpkg.git';

// =============================================================================
// Helpers
// =============================================================================

function getBootstrapScript() {
    return process.platform === 'win32'
        ? path.join(VCPKG_DIR, 'bootstrap-vcpkg')
        : path.join(VCPKG_DIR, 'bootstrap-vcpkg.sh');
}

// =============================================================================
// Action Factories
// =============================================================================

function makeCloneVcpkgAction(options = {}) {
    return {
        locks: ['vcpkg'],
        outputLines: 1,
        run: async (ctx, task) => {
            const version = await getVcpkgVersion();
            const vcpkgVersion = await getState('vcpkg.version');

            // Skip if already cloned
            if (!options.force &&
                await exists(path.join(VCPKG_DIR, '.git')) &&
                vcpkgVersion === version) {
                task.output = `v${version} already cloned`;
                return;
            }

            task.output = `Cloning v${version}...`;

            await withLock('vcpkg-clone', async () => {
                await removeDirs([VCPKG_DIR, VCPKG_INSTALLED_DIR]);
                await mkdir(BUILD_ROOT);

                try {
                    await execCommand('git', [
                        'clone', '--depth', '1', '--branch', version,
                        VCPKG_REPO, VCPKG_DIR
                    ], { task });
                } catch {
                    // Fallback: clone without depth and checkout
                    await execCommand('git', ['clone', '--depth', '100', VCPKG_REPO, VCPKG_DIR], { task });
                    await execCommand('git', ['checkout', version], { cwd: VCPKG_DIR, task });
                }

                await setState('vcpkg.state', 'cloned');
                await setState('vcpkg.version', version);
            });

            task.output = `Cloned v${version}`;
        }
    };
}

function makeBootstrapVcpkgAction(options = {}) {
    return {
        locks: ['vcpkg'],
        run: async (ctx, task) => {
            const vcpkgState = await getState('vcpkg.state');
            const vcpkgPath = path.join(VCPKG_DIR, process.platform === 'win32' ? 'vcpkg.exe' : 'vcpkg');

            // Skip if already bootstrapped
            if (!options.force && vcpkgState === 'bootstrapped' && await exists(vcpkgPath)) {
                task.output = 'Already bootstrapped';
                return;
            }

            task.output = 'Bootstrapping...';

            await withLock('vcpkg-bootstrap', async () => {
                const bootstrapScript = getBootstrapScript();
                await execCommand(bootstrapScript, ['-disableMetrics'], { cwd: VCPKG_DIR, task });
                await execCommand(path.join(VCPKG_DIR, 'vcpkg'), ['--version'], { cwd: VCPKG_DIR, task });
                await setState('vcpkg.state', 'bootstrapped');
            });

            task.output = 'Bootstrapped';
        }
    };
}

// =============================================================================
// Module Definition
// =============================================================================

module.exports = {
    name: 'vcpkg',
    description: 'C++ Package Manager',

    actions: [
        // Internal actions
        { name: 'vcpkg:clone', action: makeCloneVcpkgAction },
        { name: 'vcpkg:bootstrap', action: makeBootstrapVcpkgAction },

        // Submodule actions (called by server:build-core / server:clean-all)
        { name: 'vcpkg:submodule-build', action: () => ({
            steps: ['vcpkg:clone', 'vcpkg:bootstrap']
        })},
        { name: 'vcpkg:submodule-clean', action: () => ({
            run: async (ctx, task) => {
                await withLock('vcpkg-setup', async () => {
                    await removeDirs([VCPKG_DIR, VCPKG_INSTALLED_DIR]);
                    await setState('vcpkg.state', null);
                    await setState('vcpkg.version', null);
                });
                task.output = 'Cleaned vcpkg';
            }
        })}
    ]
};

// Export for direct use
module.exports.VCPKG_DIR = VCPKG_DIR;
module.exports.getVcpkgVersion = getVcpkgVersion;
