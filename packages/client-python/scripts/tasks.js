/**
 * Build tasks for @rocketride/client-python
 * 
 * Commands:
 *   setup - Sync source files to server dist (for server's internal use)
 *   build - Build Python wheel and sdist (for distribution)
 *   test  - Run pytest (starts test server automatically)
 *   clean - Remove build artifacts
 */
const path = require('path');
const { 
    execCommand, syncDir, formatSyncStats, 
    removeDirs, removeMatching, removeDirAndParents, PROJECT_ROOT,
    mkdir, readDir, copyFile, exists,
    startServer, stopServer,
    bracket, parallel,
    hasSourceChanged, saveSourceHash, setState
} = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src', 'rocketride');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build', 'clients', 'python');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'clients', 'python');
const SERVER_CLIENTS_DIR = path.join(PROJECT_ROOT, 'dist', 'server', 'rocketride');
const SERVER_STATIC_DIR = path.join(PROJECT_ROOT, 'dist', 'server', 'static', 'clients', 'python');

// Directories to skip when copying to build
const SKIP_DIRS = ['node_modules', '__pycache__', '.pytest_cache', 'tests', '.git', 'scripts'];

// Engine (built by server:build; execCommand resolves extension on Windows)
const ENGINE = path.join(PROJECT_ROOT, 'dist', 'server', 'engine');

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncClientPythonAction() {
    return {
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const stats = await syncDir(SRC_DIR, SERVER_CLIENTS_DIR);
            task.output = formatSyncStats(stats);
        }
    };
}

function makeWheelSourceAction() {
    return {
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const stats = await syncDir(PACKAGE_DIR, BUILD_DIR, { skipDirs: SKIP_DIRS });
            task.output = formatSyncStats(stats);
        }
    };
}

// State key for source fingerprint
const SRC_HASH_KEY = 'client-python.srcHash';

function makeWheelBuildAction() {
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
            const serverDir = path.join(PROJECT_ROOT, 'dist', 'server');
            
            await mkdir(DIST_DIR);
            await execCommand(ENGINE, [
                '-m', 'build',
                '--no-isolation',
                BUILD_DIR,
                '--outdir', DIST_DIR
            ], { task, cwd: serverDir });
            
            // Save hash after successful build
            await saveSourceHash(SRC_HASH_KEY, hash);
        }
    };
}

function makeCopyToServerStaticAction() {
    return {
        run: async (ctx, task) => {
            await mkdir(SERVER_STATIC_DIR);
            
            const files = await readDir(DIST_DIR);
            let copied = 0;
            for (const file of files) {
                if (file.endsWith('.whl') || file.endsWith('.tar.gz')) {
                    await copyFile(
                        path.join(DIST_DIR, file),
                        path.join(SERVER_STATIC_DIR, file)
                    );
                    copied++;
                }
            }
            task.output = `Copied ${copied} files to server static`;
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
            // Use existing server when ROCKETRIDE_URI is set (e.g. for debugging: start server yourself, then run tests)
            const envUri = process.env.ROCKETRIDE_URI;
            if (envUri) {
                try {
                    const u = new URL(envUri);
                    ctx.port = parseInt(u.port || '5565', 10);
                    task.output = `Using existing server at ${envUri}`;
                    return { port: ctx.port, server: null, serverUri: envUri };
                } catch (e) {
                    // Not a valid URL, fall through and start server
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
                    if (lines.length > 0) {
                        task.output = lines[lines.length - 1];
                    }
                }
            });
            
            ctx.port = result.port;
            task.output = `Server ready on port ${ctx.port}`;
            taskComplete = true;
            return { port: result.port, server: result.server };
        }
    };
}

function makeStopTestServerAction() {
    return {
        run: async (ctx, task) => {
            const bracket = ctx.brackets?.['py-test-server'];
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

function makeRunPytestAction(options = {}) {
    return {
        run: async (ctx, task) => {
            // Load .env for test configuration
            require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });
            
            const bracket = ctx.brackets?.['py-test-server'];
            const port = bracket?.port || ctx.port;
            // Use existing server URI when set (e.g. ROCKETRIDE_URI=http://localhost:5678 for debugging)
            const serverUri = bracket?.serverUri || `http://localhost:${port}`;

            // engine.exe uses an isolated environment - cwd must be dist/server
            const serverDir = path.join(PROJECT_ROOT, 'dist', 'server');
            const testEnv = {
                ...process.env,
                ROCKETRIDE_URI: serverUri
            };
            
            // Use absolute paths since cwd is dist/server
            const testsDir = path.join(PACKAGE_DIR, 'tests');
            const pytestArgs = ['-m', 'pytest', testsDir, '-v', '--rootdir', PACKAGE_DIR];
            if (options.pytest) {
                pytestArgs.push(...options.pytest);
            }
            
            await execCommand(ENGINE, pytestArgs, { 
                task, 
                cwd: serverDir,
                env: testEnv
            });
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'client-python',
    description: 'Python Client SDK',
    
    actions: [
        // Internal actions
        { name: 'client-python:sync', action: makeSyncClientPythonAction },
        { name: 'client-python:wheel-source', action: makeWheelSourceAction },
        { name: 'client-python:wheel-build', action: makeWheelBuildAction },
        { name: 'client-python:copy-to-static', action: makeCopyToServerStaticAction },
        { name: 'client-python:start-server', action: makeStartTestServerAction },
        { name: 'client-python:stop-server', action: makeStopTestServerAction },
        { name: 'client-python:run-pytest', action: makeRunPytestAction },
        
        // Public actions (have descriptions)
        { name: 'client-python:build', action: () => ({ 
            description: 'Build Python client wheel and sync to server',
            steps: [
                'server:build',
                'client-python:sync',
                'client-python:wheel-source',
                'client-python:wheel-build',
                'client-python:copy-to-static'
            ]
        })},
        { name: 'client-python:test', action: () => ({
            description: 'Run python client tests',
            steps: [
                'server:build',
                parallel([
                    'nodes:build',
                    'ai:build',
                    'client-python:build'
                ], 'Build modules'),
                'client-python:wheel-source',
                'client-python:wheel-build',
                bracket({
                    name: 'py-test-server',
                    setup: makeStartTestServerAction(),
                    teardown: makeStopTestServerAction(),
                    steps: ['client-python:run-pytest']
                })
            ]
        })},
        { name: 'client-python:clean', action: () => ({
            description: 'Remove client-python build artifacts',
            run: async (ctx, task) => {
                await removeDirs([
                    path.join(PACKAGE_DIR, 'build'),
                    path.join(PACKAGE_DIR, 'dist')
                ]);
                await removeDirAndParents(PROJECT_ROOT, [BUILD_DIR, DIST_DIR, SERVER_CLIENTS_DIR, SERVER_STATIC_DIR]);
                await removeMatching(PACKAGE_DIR, '.egg-info');
                await removeMatching(path.join(PACKAGE_DIR, 'src'), '.egg-info');
                await setState(SRC_HASH_KEY, null);
                task.output = 'Cleaned client-python';
            }
        })}
    ]
};

