/**
 * Build tasks for @aparavi/ai
 * 
 * Commands:
 *   build - Sync AI modules to dist
 *   test  - Run AI module tests
 *   clean - Remove build artifacts
 * 
 * Note: Model server tests moved to packages/model_server/scripts/tasks.js
 */
const path = require('path');
const { 
    execCommand, syncDir, formatSyncStats, PROJECT_ROOT
} = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src', 'ai');
const TESTS_DIR = path.join(PACKAGE_DIR, 'tests');
const SERVER_DIR = path.join(PROJECT_ROOT, 'dist', 'server');
const DIST_DIR = path.join(SERVER_DIR, 'ai');

// Engine executable (built by build:server)
const ENGINE_EXE = path.join(PROJECT_ROOT, 'dist', 'server', process.platform === 'win32' ? 'engine.exe' : 'engine');

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncAiAction() {
    return {
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const stats = await syncDir(SRC_DIR, DIST_DIR);
            task.output = formatSyncStats(stats);
        }
    };
}



function makeRunPytestAction(options = {}) {
    return {
        run: async (ctx, task) => {
            const pytestArgs = ['-m', 'pytest', TESTS_DIR, '-v', '--rootdir', PACKAGE_DIR];
            if (options.pytest) {
                pytestArgs.push(...options.pytest);
            }
            
            await execCommand(ENGINE_EXE, pytestArgs, { 
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
    name: 'ai',
    description: 'AI/ML Modules',
    
    actions: [
        // Internal actions
        { name: 'ai:sync', action: makeSyncAiAction },
        { name: 'ai:run-pytest', action: makeRunPytestAction },
        
        // Public actions (have descriptions)
        { name: 'ai:build', action: () => ({ 
            description: 'Sync AI modules',
            steps: ['ai:sync'] 
        })},
        { name: 'ai:test', action: () => ({
            description: 'Run AI module tests',
            steps: [
                'server:build',
                'ai:build',
                'ai:run-pytest'
            ]
        })},
        { name: 'ai:clean', action: () => ({
            description: 'Remove AI module build artifacts',
            run: async (ctx, task) => {
                const { removeDir } = require('../../../scripts/lib');
                await removeDir(DIST_DIR);
                task.output = 'Cleaned AI modules';
            }
        })}
    ]
};

// Export paths for external use
module.exports.SRC_DIR = SRC_DIR;
module.exports.DIST_DIR = DIST_DIR;
