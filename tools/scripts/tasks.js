/**
 * Build tasks for model sync tooling
 *
 * Commands:
 *   models:update - Sync LLM model lists from provider APIs, then format services.json files
 */

const path = require('path');
const {
    execCommand,
    PROJECT_ROOT, DIST_ROOT,
} = require('../../scripts/lib');

const TOOLS_SRC = path.join(__dirname, '..', 'src', 'sync_models.py');
const NODES_GLOB = path.join(PROJECT_ROOT, 'nodes', 'src', 'nodes', '**', '*.json');

// Engine (built by server:build; execCommand resolves extension on Windows)
const ENGINE = path.join(DIST_ROOT, 'server', 'engine');

// ============================================================================
// Action Factories
// ============================================================================

function makeRunSyncModelsAction(options = {}) {
    return {
        run: async (_ctx, task) => {
            // Load .env so provider API keys are available
            require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

            // Collect args from --models="..." flags (can be repeated; each value
            // is split on whitespace so --models="--all --apply" works).
            const modelsOpts = options.models || [];
            const extraArgs = modelsOpts.flatMap(o => String(o).split(/\s+/).filter(Boolean));

            task.output = `Running sync_models ${extraArgs.join(' ')}`.trim();

            await execCommand(ENGINE, [TOOLS_SRC, ...extraArgs], {
                task,
                cwd: PROJECT_ROOT,
                env: { ...process.env },
            });
        }
    };
}

function makePrettierAction() {
    return {
        run: async (_ctx, task) => {
            task.output = 'Formatting services.json files...';

            await execCommand('npx', [
                'prettier',
                '--write',
                NODES_GLOB,
            ], {
                task,
                cwd: PROJECT_ROOT,
            });

            task.output = 'Formatted';
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'models',
    description: 'LLM Model Sync',

    actions: [
        // Internal steps
        { name: 'models:run-sync', action: makeRunSyncModelsAction },
        { name: 'models:prettier', action: makePrettierAction },

        // Public action
        { name: 'models:update', action: () => ({
            description: 'Sync LLM model lists from provider APIs and format JSON files',
            steps: ['models:run-sync', 'models:prettier'],
        })},
    ]
};
