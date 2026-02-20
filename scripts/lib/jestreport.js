/**
 * Jest Reporter - Outputs [PASSED]/[FAILED] after each test
 * 
 * Usage in jest.config.js:
 *   testRunner: 'jest-jasmine2',
 *   setupFilesAfterEnv: ['../../scripts/lib/jestreport.js'],
 * 
 * Requires: jest-jasmine2 package
 */

/** Output only the last line (split by \n or \r) */
function outputLastLine(text) {
    const lines = text.split(/[\r\n]+/).filter(l => l.trim());
    if (lines.length > 0) {
        process.stdout.write(lines[lines.length - 1] + '\n');
    }
}

// Access jasmine through global (available with jest-jasmine2 runner)
const jasmineEnv = global.jasmine?.getEnv?.();

if (jasmineEnv) {
    jasmineEnv.addReporter({
        specDone(result) {
            if (result.status === 'passed') {
                outputLastLine(`[PASSED]: ${result.fullName}`);
            } else if (result.status === 'failed') {
                outputLastLine(`[FAILED]: ${result.fullName}`);
            }
        },
    });
}

