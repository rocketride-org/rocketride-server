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
 * Build tasks for @rocketride/client-mcp
 * 
 * Commands:
 *   build - Build Python wheel and sdist
 *   test  - Run pytest (starts test server automatically)
 *   clean - Remove build artifacts
 */
const path = require('path');
const {
    execCommand, syncDir, formatSyncStats,
    removeDirs, removeMatching, removeDirAndParents, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT,
    mkdir, copyFile, exists,
    hasSourceChanged, saveSourceHash, setState,
    startServer, stopServer,
    bracket, parallel
} = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const BUILD_DIR = path.join(BUILD_ROOT, 'clients', 'mcp');
const DIST_DIR = path.join(DIST_ROOT, 'clients', 'mcp');
const SERVER_DIR = path.join(DIST_ROOT, 'server');
const SERVER_STATIC_DIR = path.join(SERVER_DIR, 'static', 'clients', 'mcp');

// Engine (built by server:build; execCommand resolves extension on Windows)
const ENGINE = path.join(SERVER_DIR, 'engine');

// State key for source fingerprint
const SRC_HASH_KEY = 'client-mcp.srcHash';

// Glob patterns to ignore when copying to build
const IGNORE = ['**/node_modules/**', '**/__pycache__/**', '**/.pytest_cache/**', '**/tests/**', '**/.git/**', '**/scripts/**'];

// Canonical README lives in docs/; copy it into the build dir for wheel packaging
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const README_SRC = path.join(DOCS_DIR, 'README-mcp-client.md');
const README_DEST = path.join(BUILD_DIR, 'README.md');

// ============================================================================
// Action Factories
// ============================================================================

function makeCopyReadmeAction() {
    return {
        run: async (ctx, task) => {
            await copyFile(README_SRC, README_DEST);
            task.output = 'Copied README into build dir';
        }
    };
}

function makeSyncSourceAction() {
    return {
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const stats = await syncDir(PACKAGE_DIR, BUILD_DIR, { ignore: IGNORE });
            task.output = formatSyncStats(stats);
        }
    };
}

function makeBuildWheelAction() {
    return {
        run: async (ctx, task) => {
            // Check if source changed
            const { changed, hash } = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);
            const outputExists = await exists(DIST_DIR);

            if (!changed && outputExists) {
                task.output = 'No changes detected';
                return;
            }

            // engine.exe uses an isolated environment - cwd must be dist/server
            await mkdir(DIST_DIR);
            await execCommand(ENGINE, [
                '-m', 'build',
                '--no-isolation',
                BUILD_DIR,
                '--outdir', DIST_DIR
            ], { task, cwd: SERVER_DIR });

            // Copy wheel and sdist to server static directory
            const stats = await syncDir(DIST_DIR, SERVER_STATIC_DIR, { pattern: ['*.whl', '*.tar.gz'], package: true });
            task.output = formatSyncStats(stats);

            // Save hash after successful build
            await saveSourceHash(SRC_HASH_KEY, hash);
        }
    };
}

function makeRunPytestAction(options = {}) {
    return {
        run: async (ctx, task) => {
            require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

            const bracket = ctx.brackets?.['mcp-test-server'];
            const port = bracket?.port || ctx.port;
            const serverUri = bracket?.serverUri || `http://localhost:${port}`;

            // Install MCP test dependencies
            task.output = 'Installing test deps (mcp, python-dotenv)...';
            await execCommand(ENGINE, [
                '-m', 'pip', 'install', 'mcp>=1.2.0', 'python-dotenv>=1.0.0', '--quiet'
            ], { task, cwd: SERVER_DIR });

            // Run pytest
            const buildSrcDir = path.join(BUILD_DIR, 'src');
            const testsDir = path.join(PACKAGE_DIR, 'tests');
            const pytestArgs = ['-m', 'pytest', testsDir, '-v', '--rootdir', PACKAGE_DIR];
            if (options.pytest) {
                pytestArgs.push(...options.pytest);
            }
            await execCommand(ENGINE, pytestArgs, {
                task,
                cwd:  SERVER_DIR,
                env: {
                    ...process.env,
                    ROCKETRIDE_URI: serverUri,
                    PYTHONPATH: buildSrcDir
                }
            });
        }
    };
}

function makeStartTestServerAction(options = {}) {
    return {
        run: async (ctx, task) => {
            if (options.testport) {
                ctx.port = options.testport;
                task.output = `Using existing server on port ${ctx.port}`;
                return { port: ctx.port, server: null };
            }
            const envUri = process.env.ROCKETRIDE_URI;
            if (envUri) {
                try {
                    const u = new URL(envUri);
                    ctx.port = parseInt(u.port || '5565', 10);
                    task.output = `Using existing server at ${envUri}`;
                    return { port: ctx.port, server: null, serverUri: envUri };
                } catch (e) {
                    // fall through and start server
                }
            }
            task.output = 'Starting server...';
            let taskComplete = false;
            const result = await startServer({
                script: 'ai/eaas.py',
                trace: options.trace,
                basePort: 20000,
                onOutput: (text) => {
                    if (taskComplete) return;
                    const lines = text.trim().split('\n');
                    if (lines.length > 0) task.output = lines[lines.length - 1];
                }
            });
            ctx.port = result.port;
            task.output = `Server ready on port ${result.port}`;
            taskComplete = true;
            return { port: result.port, server: result.server };
        }
    };
}

function makeStopTestServerAction() {
    return {
        run: async (ctx, task) => {
            const bracket = ctx.brackets?.['mcp-test-server'];
            if (bracket?.server) {
                task.output = 'Stopping server...';
                await stopServer({ server: bracket.server });
                task.output = 'Server stopped';
            } else {
                task.output = 'No server to stop';
            }
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'client-mcp',
    description: 'MCP Client (Model Context Protocol)',

    actions: [
        // Internal actions
        { name: 'client-mcp:copy-readme', action: makeCopyReadmeAction },
        { name: 'client-mcp:sync-source', action: makeSyncSourceAction },
        { name: 'client-mcp:run-pytest', action: makeRunPytestAction },

        // Public actions (have descriptions)
        { name: 'client-mcp:build', action: () => ({
            description: 'Build MCP client',
            steps: [
                'server:build',
                'client-mcp:sync-source',
                'client-mcp:copy-readme',
                'client-mcp:build-wheel',
            ]
        })},
        { name: 'client-mcp:build-wheel', action: makeBuildWheelAction },
        { name: 'client-mcp:test', action: () => ({
            description: 'Test MCP client',
            steps: [
                parallel([
                    'ai:build',
                    'nodes:build',
                    'client-mcp:build',
                    'client-python:build'
                ], 'Build dependencies'),
                bracket({
                    name: 'mcp-test-server',
                    setup: makeStartTestServerAction(),
                    teardown: makeStopTestServerAction(),
                    steps: ['client-mcp:run-pytest']
                })
            ]
        })},
        { name: 'client-mcp:clean', action: () => ({
            description: 'Clean MCP client',
            run: async (ctx, task) => {
                await removeDirs([
                    path.join(PACKAGE_DIR, 'build'),
                    path.join(PACKAGE_DIR, 'dist')
                ]);
                await removeDirAndParents(PROJECT_ROOT, [BUILD_DIR, DIST_DIR, SERVER_STATIC_DIR]);
                await removeMatching(PACKAGE_DIR, '.egg-info');
                await removeMatching(path.join(PACKAGE_DIR, 'src'), '.egg-info');
                await setState(SRC_HASH_KEY, null);
                task.output = 'Cleaned client-mcp';
            }
        })}
    ]
};
