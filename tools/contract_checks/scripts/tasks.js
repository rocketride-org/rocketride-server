// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Build tasks for the check-externals framework.
 *
 * Public commands:
 *   check-externals:run                  Run third-party interface contract
 *                                        checks against the four scanned trees.
 *   check-externals:run --rebuild-cache  Force ensure_constraints() to
 *                                        recompile by deleting
 *                                        <engine-cache>/{constraints.txt,
 *                                        requirements.hash}. Used by the
 *                                        nightly cron lane to catch fresh
 *                                        upstream releases.
 *   check-externals:test                 Run unit tests for the framework
 *                                        itself (extractor + runner). No
 *                                        engine trees are built; only the
 *                                        engine binary is needed.
 *
 * Internal commands (used as compound-step targets; visible in
 * `--list-actions` but not in `--help` since they have no description):
 *   check-externals:run-checks           Just the CLI invocation, no build steps.
 *                                        Useful for fast iteration when the
 *                                        engine + trees are already built.
 *   check-externals:run-tests            Just the pytest invocation, no build steps.
 *
 * IMPORTANT: an action with BOTH `steps` AND `run` silently drops `run`
 * (see action-runner.js buildCompoundTask — it only calls task.newListr on
 * the children, never actionObj.run). So each public compound action is
 * paired with an internal leaf that carries the actual `run` callback.
 */

const path = require('path');
const { execCommand, runPytest, unlink, DIST_ROOT } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const TEST_DIR = path.join(PACKAGE_DIR, 'test');

// CLI entry point for `check-externals:run` (no pytest).
// `cli.py` adjusts sys.path then delegates to `contract_checks.cli:main`.
const CLI_SCRIPT = path.join(PACKAGE_DIR, 'cli.py');

// Engine binary (built by server:build; execCommand resolves extension on Windows).
const ENGINE = path.join(DIST_ROOT, 'server', 'engine');

// depends.engine_cache_dir() = <engine executable dir>/cache.
const ENGINE_CACHE_DIR = path.join(DIST_ROOT, 'server', 'cache');


// ============================================================================
// Leaf actions (carry the actual run callbacks)
// ============================================================================

function makeRunChecksAction(options = {}) {
    return {
        // No description -> internal; reached as the final step of
        // `check-externals:run`, or invoked directly for fast dev iteration.
        run: async (ctx, task) => {
            if (options.rebuildCache) {
                const constraints = path.join(ENGINE_CACHE_DIR, 'constraints.txt');
                const hashFile = path.join(ENGINE_CACHE_DIR, 'requirements.hash');
                await unlink(constraints);
                await unlink(hashFile);
                task.output = 'Constraint cache cleared; ensure_constraints() will recompile';
            }

            // Invoke the CLI directly — no pytest. The CLI implements the
            // verification loop itself (find_spec for skip-on-missing,
            // verify_* for each contract entry, exit code from failure
            // count). pytest only runs under check-externals:run-tests.
            const cliArgs = [CLI_SCRIPT];
            // Prefer --pattern (framework-native); fall back to --pytest-pattern
            // for users with muscle memory from pytest-based tasks like nodes:test.
            // options.pattern is always a list (build.js accumulates). The CLI
            // supports `--pattern` multiple times with OR semantics, so we forward
            // each entry as its own flag occurrence.
            const patterns = options.pattern || (options.pytestPattern ? [options.pytestPattern] : []);
            for (const p of patterns) {
                cliArgs.push('--pattern', p);
            }

            // --install-all: forwarded as-is to the CLI. Nightly cron lane
            // sets this so the framework installs every requirement*.txt
            // even when carrying a `# contract-check: skip-install` marker.
            if (options.installAll) {
                cliArgs.push('--install-all');
            }

            await execCommand(ENGINE, cliArgs, {
                task,
                cwd: path.join(DIST_ROOT, 'server'),
                env: { ...process.env },
            });
        },
    };
}


function makeRunTestsAction(options = {}) {
    return {
        // No description -> internal; reached as the final step of
        // `check-externals:test`.
        run: async (ctx, task) => {
            const extraArgs = ['-v', '--tb=short'];

            // Accept both --pattern and --pytest-pattern; this lane is real
            // pytest, so either maps to pytest's -k expression. pytest only
            // accepts ONE -k arg, so join multiple --pattern values with
            // ` or ` (pytest's OR operator) to preserve the OR semantics.
            const patterns = options.pattern || (options.pytestPattern ? [options.pytestPattern] : []);
            if (patterns.length > 0) {
                extraArgs.push('-k', patterns.join(' or '));
            }

            // Target the two self-test files directly so collection doesn't
            // also pull in any future parametrized contract tests (which
            // would require the four trees to be built).
            for (const fname of ['test_extractor.py', 'test_runner.py']) {
                await runPytest({
                    engine: ENGINE,
                    testsDir: path.join(TEST_DIR, fname),
                    extraArgs,
                    execOpts: {
                        task,
                        cwd: path.join(DIST_ROOT, 'server'),
                        env: { ...process.env },
                    },
                });
            }
        },
    };
}


// ============================================================================
// Public compound actions (only `steps` — no `run`, so action-runner won't
// silently drop anything)
// ============================================================================


module.exports = {
    name: 'check-externals',
    description: '3rd-party interface contract test framework',

    actions: [
        // Internal leaf actions — these carry the real run callbacks.
        { name: 'check-externals:run-checks', action: makeRunChecksAction },
        { name: 'check-externals:run-tests', action: makeRunTestsAction },

        // Public compound actions — build deps + the matching leaf.
        { name: 'check-externals:run', action: () => ({
            description: 'Check interfaces to 3rd-party Python modules used by the engine',
            // Build the engine + the four scanned trees so depends() can install
            // every component's requirements.txt at session start. The leaf
            // step at the end actually invokes the CLI.
            steps: [
                'server:build',
                'nodes:build',
                'ai:build',
                'client-python:build',
                'check-externals:run-checks',
            ],
        })},
        { name: 'check-externals:test', action: () => ({
            description: 'Unit tests for the check-externals framework itself',
            // Only the engine is required; the four trees are not scanned by
            // these tests, so we don't need to build them.
            steps: ['server:build', 'check-externals:run-tests'],
        })},
    ],
};
