/**
 * Test UI Build Module
 *
 * Stress & chaos testing dashboard for the RocketRide backend.
 */
const path = require('path');
const { createAppModule } = require('../../../scripts/lib/appModule');

module.exports = createAppModule({
	name: 'test-ui',
	description: 'Test UI Application',
	appRoot: path.join(__dirname, '..'),
	dev: true,
});
