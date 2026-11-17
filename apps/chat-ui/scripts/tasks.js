/**
 * Chat UI Build Module
 *
 * The chat front end of a pipeline: a dev tool beside the canvas and a
 * signed-in shell app by deep link (plan 3.6).
 */

const path = require('path');
const { createAppModule } = require('../../../scripts/lib/appModule');

module.exports = createAppModule({
	name: 'chat-ui',
	description: 'RocketRide Chat — pipeline chat front end',
	appRoot: path.join(__dirname, '..'),
	dev: true,
});
