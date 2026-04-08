/**
 * Task Runner - Executes build tasks
 * 
 * Uses the two-phase architecture:
 * Phase 1: Build complete task tree before execution
 * Phase 2: Execute via Listr2 with runtime deduplication
 */
const registry = require('./registry');
const { buildTaskTree, resetActionTracking } = require('./action-runner');
const { setTaskDebugVerbose } = require('./debug');
const { Listr } = require('listr2');

// Output lines to show per task
const OUTPUT_LINES = 5;

class TaskRunner {
    constructor(options = {}) {
        this.options = {
            force: false,
            verbose: false,
            parallel: true,
            ...options
        };
        // Pass options to context so actions can access CLI args (pytest, jest, etc.)
        this.context = { options: this.options };
    }
    
    /**
     * Run a list of module:command requests
     * @param {Array<{module: string, command: string}>} requests
     */
    async run(requests) {
        if (requests.length === 0) {
            console.log('No tasks to run.');
            return;
        }
        
        // Reset action tracking for fresh session
        resetActionTracking();
        setTaskDebugVerbose(this.options.verbose);

        // Phase 1: Build complete task tree for all requests
        const listrTasks = requests.map(req => this._createModuleTask(req.module, req.command));
        
        // Phase 2: Execute via Listr2
        const runner = new Listr(listrTasks, {
            concurrent: this.options.parallel,
            exitOnError: true,
            rendererOptions: {
                collapseSubtasks: !this.options.verbose,
                collapseErrors: false,
                showTimer: true
            },
            renderer: this.options.verbose || process.env.CI ? 'verbose' : 'default'
        });
        
        await runner.run(this.context);
    }
    
    /**
     * Create a task for an action
     * 
     * Pre-builds the complete subtask tree so Listr2 knows
     * the full structure before execution begins.
     */
    _createModuleTask(moduleName, actionName) {
        const module = registry.get(moduleName);
        if (!module) {
            throw new Error(`Unknown module: ${moduleName}`);
        }
        
        const actionDef = registry.getAction(actionName);
        if (!actionDef) {
            throw new Error(`Unknown action '${actionName}'`);
        }
        
        const actionObj = typeof actionDef.action === 'function'
            ? actionDef.action(this.options)
            : actionDef.action;

        // Compound action with steps
        if (actionObj.steps && Array.isArray(actionObj.steps)) {
            const childTasks = buildTaskTree(actionObj.steps, new Set(), actionName, this.options);
            
            return {
                title: actionObj.description || actionName,
                task: (ctx, task) => {
                    if (childTasks.length === 0) {
                        task.skip('No tasks defined');
                        return;
                    }
                    
                    return task.newListr(childTasks, {
                        concurrent: false,
                        exitOnError: true,
                        rendererOptions: {
                            collapseSubtasks: !this.options.verbose
                        }
                    });
                },
                exitOnError: true,
                rendererOptions: {
                    outputBar: OUTPUT_LINES
                }
            };
        }
        
        // Leaf action with run function
        if (actionObj.run) {
            return {
                title: actionObj.description || actionName,
                task: async (ctx, task) => {
                    task._logModule = actionName;
                    return await actionObj.run(ctx, task, { logModule: actionName });
                },
                exitOnError: true,
                rendererOptions: {
                    outputBar: OUTPUT_LINES
                }
            };
        }
        
        throw new Error(`Action '${actionName}' has no steps or run function`);
    }
}

module.exports = TaskRunner;
