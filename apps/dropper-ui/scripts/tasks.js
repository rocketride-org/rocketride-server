/**
 * Dropper UI Build Module
 *
 * The drag-and-drop upload front end of a pipeline: a dev tool beside the
 * canvas and a signed-in shell app by deep link (plan 3.6).
 */

const path = require('path');
const { createAppModule } = require('../../../scripts/lib/appModule');

module.exports = createAppModule({
	name: 'dropper-ui',
	description: 'RocketRide Dropper — pipeline upload front end',
	appRoot: path.join(__dirname, '..'),
	dev: true,
});
