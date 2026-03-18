/**
 * Module Registry - Auto-discovers and manages build modules
 * 
 * Finds tasks.js files throughout the project and registers them.
 */
const path = require('path');
const { exists } = require('./fs');

class ModuleRegistry {
    constructor() {
        this.modules = new Map();
    }

    /**
     * Discover all tasks.js files in the project
     * Searches for scripts/tasks.js in packages/, apps/, and nodes/
     */
    async discover(rootDir) {
        const { glob } = require('glob');
        const parse = require('gitignore-globs');

        const gitignorePath = path.join(rootDir, '.gitignore');
        const gitignore = await exists(gitignorePath) ? parse(gitignorePath) : [];

        const taskFiles = await glob([
            '{packages,apps,nodes,examples}/**/scripts/tasks.js',
            'scripts/tasks.js',
        ], {
            cwd: rootDir,
            ignore: gitignore,
            absolute: true,
            nodir: true
        });

        for (const taskFile of taskFiles) {
            await this._loadModule(taskFile);
        }

        return this;
    }

    async _loadModule(filePath) {
        try {
            // Clear require cache for hot reloading during development
            delete require.cache[require.resolve(filePath)];

            const mod = require(filePath);

            if (!mod.name) {
                console.warn(`  Warning: ${filePath} missing 'name' property, skipping`);
                return;
            }

            // Store the module's directory for context
            mod._path = path.dirname(filePath);
            mod._file = filePath;

            this.modules.set(mod.name, mod);
        } catch (err) {
            console.warn(`  Warning: Could not load ${filePath}: ${err.message}`);
        }
    }

    /**
     * Get a module by name
     */
    get(name) {
        return this.modules.get(name);
    }

    /**
     * Check if a module exists
     */
    has(name) {
        return this.modules.has(name);
    }

    /**
     * Get all module names
     */
    names() {
        return Array.from(this.modules.keys());
    }

    /**
     * List all public actions (actions with descriptions)
     * 
     * Actions with descriptions are shown in `builder --help`.
     * Actions without descriptions are internal/private but still callable.
     */
    listCommands(options) {
        const result = [];

        for (const [moduleName, mod] of this.modules) {
            if (!mod.actions) continue;

            for (const actionDef of mod.actions) {
                const actionObj = typeof actionDef.action === 'function'
                    ? actionDef.action(options)
                    : actionDef.action;

                // Only list actions that have descriptions (public actions)
                if (actionObj?.description) {
                    result.push({
                        module: moduleName,
                        command: actionDef.name,
                        full: actionDef.name,
                        description: actionObj.description
                    });
                }
            }
        }

        return result.sort((a, b) => a.full.localeCompare(b.full));
    }

    /**
     * Get an action by name (module:action-name format)
     * Looks up from the module's top-level actions array
     * 
     * @param {string} actionName - Action name like 'vcpkg:clone' or 'java:setup-jdk'
     * @returns {object|null} The action definition { name, action } or null if not found
     */
    getAction(actionName) {
        // Parse module:action format
        const colonIdx = actionName.indexOf(':');
        if (colonIdx === -1) return null;

        const moduleName = actionName.substring(0, colonIdx);
        const mod = this.modules.get(moduleName);
        if (!mod) return null;

        // Look up in the module's actions array
        if (!mod.actions) return null;

        return mod.actions.find(a => a.name === actionName) || null;
    }

    /**
     * List all registered actions across all modules
     * @returns {Array} Array of { name, description, module }
     */
    listActions(options) {
        const actions = [];

        for (const [moduleName, mod] of this.modules) {
            if (!mod.actions) continue;

            for (const actionDef of mod.actions) {
                const actionObj = typeof actionDef.action === 'function'
                    ? actionDef.action(options)
                    : actionDef.action;
                actions.push({
                    name: actionDef.name,
                    description: actionObj?.description || '',
                    module: moduleName
                });
            }
        }

        return actions.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Print discovered modules
     */
    printDiscovered() {
        console.log('Discovered modules:');
        for (const [name, mod] of this.modules) {
            const actions = (mod.actions || []).map(a => a.name).join(', ');
            console.log(`  ${name.padEnd(20)} ${mod.description || ''}`);
            console.log(`    Actions: ${actions}`);
        }
    }
}

module.exports = new ModuleRegistry();
