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

// Maps provider key → relative path to its services.json from the repo root.
// Mirrors _SERVICES_JSON_PATHS in tools/src/sync_models.py.
const SERVICES_JSON_PATHS = {
    llm_openai: 'nodes/src/nodes/llm_openai/services.json',
    embedding_openai: 'nodes/src/nodes/embedding_openai/services.json',
    llm_anthropic: 'nodes/src/nodes/llm_anthropic/services.json',
    llm_gemini: 'nodes/src/nodes/llm_gemini/services.json',
    llm_mistral: 'nodes/src/nodes/llm_mistral/services.json',
    llm_deepseek: 'nodes/src/nodes/llm_deepseek/services.json',
    llm_xai: 'nodes/src/nodes/llm_xai/services.json',
    llm_perplexity: 'nodes/src/nodes/llm_perplexity/services.json',
    llm_qwen: 'nodes/src/nodes/llm_qwen/services.json',
};

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

function makePrettierAction(options = {}) {
    return {
        run: async (_ctx, task) => {
            const modelsOpts = options.models || [];
            const extraArgs = modelsOpts.flatMap((o) => String(o).split(/\s+/).filter(Boolean));

            let targetFiles;
            if (extraArgs.includes('--all')) {
                targetFiles = Object.values(SERVICES_JSON_PATHS).map((p) => path.join(PROJECT_ROOT, p));
            } else {
                const providers = [];
                for (let i = 0; i < extraArgs.length; i++) {
                    if (extraArgs[i] === '--provider' && i + 1 < extraArgs.length) {
                        providers.push(extraArgs[i + 1]);
                    }
                }
                targetFiles = providers
                    .filter((p) => SERVICES_JSON_PATHS[p])
                    .map((p) => path.join(PROJECT_ROOT, SERVICES_JSON_PATHS[p]));
            }

            if (targetFiles.length === 0) {
                task.output = 'No files to format';
                return;
            }

            task.output = `Formatting ${targetFiles.length} services.json file(s)...`;

            await execCommand('npx', ['prettier', '--write', ...targetFiles], {
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
