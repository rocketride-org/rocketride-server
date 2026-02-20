const fs = require('fs');
const path = require('path');

// Prefer out/ for debugging, fall back to dist/
const outPath = path.join(__dirname, 'out', 'extension.js');
const distPath = path.join(__dirname, 'dist', 'extension.js');

if (fs.existsSync(outPath)) {
	module.exports = require(outPath);
} else {
	module.exports = require(distPath);
}
