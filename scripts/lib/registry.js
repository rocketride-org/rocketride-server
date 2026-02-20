/**
 * Module Registry - Auto-discovers and manages build modules
 * 
 * Finds tasks.js files throughout the project and registers them.
 */
const path = require('path');
const { exists, readDir } = require('./fs');

class ModuleRegistry {
    constructor() {
        this.modules = new Map();
    }
    
    /**
     * Discover all tasks.js files in the project
     * Searches for scripts/tasks.js in packages/, apps/, and nodes/
     */
    async discover(rootDir) {
        // Only search in these top-level directories
        const searchRoots = ['packages', 'apps', 'nodes', 'examples'];
        
        for (const dir of searchRoots) {
            const fullPath = path.join(rootDir, dir);
            if (await exists(fullPath)) {
                await this._findTasksRecursive(fullPath, 0);
            }
        }

        // Also check for a root-level scripts/tasks.js (overlay entry point)
        const rootTasks = path.join(rootDir, 'scripts', 'tasks.js');
        if (await exists(rootTasks)) {
            await this._loadModule(rootTasks);
        }

        return this;
    }
    
    async _findTasksRecursive(dir, depth) {
        // Limit depth to avoid searching too deep (node_modules, .git, etc.)
        if (depth > 5) return;
        
        // Skip common directories that shouldn't contain build modules
        const skipDirs = ['node_modules', '.git', 'dist', 'build', '.vscode', '.idea'];
        
        try {
            const entries = await readDir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (skipDirs.includes(entry.name)) continue;
                if (entry.name.startsWith('.')) continue;
                
                const fullPath = path.join(dir, entry.name);
                
                // Check for scripts/tasks.js in this directory
                if (entry.name === 'scripts') {
                    const tasksFile = path.join(fullPath, 'tasks.js');
                    if (await exists(tasksFile)) {
                        await this._loadModule(tasksFile);
                    }
                } else {
                    // Recurse into subdirectory
                    await this._findTasksRecursive(fullPath, depth + 1);
                }
            }
        } catch {
            // Ignore permission errors, etc.
        }
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
    listCommands() {
        const result = [];
        
        for (const [moduleName, mod] of this.modules) {
            if (!mod.actions) continue;
            
            for (const actionDef of mod.actions) {
                const actionObj = typeof actionDef.action === 'function' 
                    ? actionDef.action() 
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
    listActions() {
        const actions = [];
        
        for (const [moduleName, mod] of this.modules) {
            if (!mod.actions) continue;
            
            for (const actionDef of mod.actions) {
                const actionObj = typeof actionDef.action === 'function' 
                    ? actionDef.action() 
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
