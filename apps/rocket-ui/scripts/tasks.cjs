/**
 * Data Toolchain UI Build Module
 *
 * React-based data toolchain interface application.
 */
const path = require('path');
const { readdir } = require('node:fs/promises');
const { execCommand } = require('../../../scripts/lib');
const { createAppModule } = require('../../../scripts/lib/appModule');

const APP_ROOT = path.join(__dirname, '..');

const appModule = createAppModule({
	name: 'rocket-ui',
	description: 'Data Toolchain Interface Application',
	appRoot: APP_ROOT,
	dev: true,
});

appModule.actions.push({
	name: 'rocket-ui:test',
	action: () => ({
		description: 'Testing rocket-ui',
		run: async (ctx, task) => {
			const testFiles = (await readdir(path.join(APP_ROOT, 'src'), { recursive: true }))
				.filter((f) => f.endsWith('.test.ts'))
				.map((f) => path.join('src', f));
			await execCommand('node', ['--import', 'tsx', '--test', '--test-reporter=spec', ...testFiles], {
				task,
				cwd: APP_ROOT,
			});
		},
	}),
});

module.exports = appModule;
