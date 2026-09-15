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
	 * Searches for scripts/tasks.js in packages/, apps/, nodes/, shared/, ...
	 */
	async discover(rootDir) {
		const { glob } = require('glob');
		const parse = require('gitignore-globs');

		const gitignorePath = path.join(rootDir, '.gitignore');
		// gitignore-globs keeps the \r of CRLF checkouts in its patterns,
		// which makes every produced glob match nothing — strip it.
		const gitignore = (await exists(gitignorePath)) ? parse(gitignorePath).map((g) => g.replace(/\r/g, '')) : [];

		const taskFiles = await glob(['{packages,apps,nodes,examples,extension,tools,shared,docs}/**/scripts/tasks.{js,cjs}', 'scripts/tasks.{js,cjs}'], {
			cwd: rootDir,
			// A tasks.js inside any node_modules is never a build module
			// (installed/materialized packages ship their dev files), so it
			// is excluded regardless of what the gitignore contributes.
			ignore: ['**/node_modules/**', ...gitignore],
			absolute: true,
			nodir: true,
		});

		// Shallowest first: the root's own scripts/tasks.js loads before any
		// nested repo's copy of it (e.g. the apps/stock submodule), so with
		// first-wins registration below, shared module names (ui, builder)
		// always resolve to THIS root's copy — the one whose lib/registry is
		// the instance actually running the build.
		taskFiles.sort((a, b) => {
			const depth = (f) => path.relative(rootDir, f).split(path.sep).length;
			return depth(a) - depth(b) || a.localeCompare(b);
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

			const exported = require(filePath);

			// A tasks.js may export either a single module object {name, actions}
			// or an array of such objects. Array form lets one file register
			// several modules under different action prefixes — useful when an
			// overlay (e.g. extension/) wants to expose multiple action namespaces
			// without spawning a `<sub>/scripts/tasks.js` per namespace.
			const mods = Array.isArray(exported) ? exported : [exported];

			for (const mod of mods) {
				if (!mod || !mod.name) {
					console.warn(`  Warning: ${filePath} entry missing 'name' property, skipping`);
					continue;
				}

				// First registration wins — never re-register a module name.
				// Combined with the shallowest-first load order, a nested
				// repo's copy of a shared module can't shadow the root's.
				if (this.modules.has(mod.name)) continue;

				// Store the module's directory for context
				mod._path = path.dirname(filePath);
				mod._file = filePath;

				this.modules.set(mod.name, mod);
			}
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
				const actionObj = typeof actionDef.action === 'function' ? actionDef.action(options) : actionDef.action;

				// Only list actions that have descriptions (public actions)
				if (actionObj?.description) {
					result.push({
						module: moduleName,
						command: actionDef.name,
						full: actionDef.name,
						description: actionObj.description,
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

		return mod.actions.find((a) => a.name === actionName) || null;
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
				const actionObj = typeof actionDef.action === 'function' ? actionDef.action(options) : actionDef.action;
				actions.push({
					name: actionDef.name,
					description: actionObj?.description || '',
					module: moduleName,
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
			const actions = (mod.actions || []).map((a) => a.name).join(', ');
			console.log(`  ${name.padEnd(20)} ${mod.description || ''}`);
			console.log(`    Actions: ${actions}`);
		}
	}
}

module.exports = new ModuleRegistry();
