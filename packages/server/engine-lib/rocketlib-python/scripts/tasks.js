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
 * Build tasks for the rocketlib Python package.
 *
 * Commands:
 *   test - Run rocketlib unit tests (uses dist/server/engine as Python interp
 *          so the engLib C extension is importable).
 *
 * The package itself is synced into dist/server by server:setup-python (via
 * server:build), so there is no separate sync step here — depending on
 * server:build is enough to make `from rocketlib import ...` work in tests.
 */
const path = require('path');
const { execCommand, DIST_ROOT } = require('../../../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const TESTS_DIR = path.join(PACKAGE_DIR, 'tests');
const SERVER_DIR = path.join(DIST_ROOT, 'server');
const ENGINE = path.join(SERVER_DIR, 'engine');

// ============================================================================
// Action Factories
// ============================================================================

function makeRunPytestAction(options = {}) {
    return {
        run: async (ctx, task) => {
            const pytestArgs = ['-m', 'pytest', TESTS_DIR, '-v', '--rootdir', PACKAGE_DIR];
            if (options.pytest) {
                if (typeof options.pytest === 'string') {
                    pytestArgs.push(...options.pytest.split(/\s+/).filter(Boolean));
                } else if (Array.isArray(options.pytest)) {
                    for (const opt of options.pytest) {
                        pytestArgs.push(...String(opt).split(/\s+/).filter(Boolean));
                    }
                }
            }

            await execCommand(ENGINE, pytestArgs, {
                task,
                cwd: SERVER_DIR
            });
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'rocketlib',
    description: 'rocketlib Python package',

    actions: [
        // Internal actions
        { name: 'rocketlib:run-pytest', action: makeRunPytestAction },

        // Public actions (have descriptions)
        {
            name: 'rocketlib:test', action: (options) => ({
                description: 'Test rocketlib Python helpers',
                steps: [
                    'server:build',
                    'rocketlib:run-pytest'
                ],
                options
            })
        }
    ]
};

// Export paths for external use
module.exports.PACKAGE_DIR = PACKAGE_DIR;
module.exports.TESTS_DIR = TESTS_DIR;
