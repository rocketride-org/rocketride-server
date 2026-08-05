/**
 * Events UI Build Module
 *
 * Real-time DAP event monitor — stream, inspect, and export server events.
 */
const path = require('path');
const { createAppModule } = require('../../../scripts/lib/appModule');

module.exports = createAppModule({
	name: 'events-ui',
	description: 'Event Monitor Application',
	appRoot: path.join(__dirname, '..'),
	dev: true,
});
