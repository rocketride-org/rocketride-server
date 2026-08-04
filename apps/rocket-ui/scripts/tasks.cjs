/**
 * Data Toolchain UI Build Module
 *
 * React-based data toolchain interface application.
 */
const path = require('path');
const { createAppModule } = require('../../../scripts/lib/appModule');

module.exports = createAppModule({
	name: 'rocket-ui',
	description: 'Data Toolchain Interface Application',
	appRoot: path.join(__dirname, '..'),
	dev: true,
});
