# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Check secure read credentials with RocketRide's form validator."""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
RJSF = ROOT / 'apps' / 'shared' / 'node_modules' / '@rjsf' / 'validator-ajv8'
TSX = ROOT / 'apps' / 'shared' / 'node_modules' / 'tsx' / 'dist' / 'cjs' / 'index.cjs'


@pytest.mark.skipif(
    not shutil.which('node') or not RJSF.exists() or not TSX.exists(),
    reason='RocketRide UI dependencies are not installed',
)
def test_read_secret_stored_missing_and_replaced():
    """Validate read secrets with the same stored-field handling as the UI."""
    script = r"""
const fs = require('fs');
const { getSecuredFormData, removeRequired, validateFormData } = require('./apps/shared/src/components/node-config/rjsf.ts');
const service = JSON.parse(fs.readFileSync('nodes/src/nodes/tool_auth0/services.json'));
const schema = { type: 'object', properties: {
  clientSecret: service.fields['auth0.clientSecret'], secureParameters: {type: 'object'}
}, required: ['clientSecret'] };
const cases = [
  ['stored and empty', {clientSecret:'', secureParameters:{secure:['clientSecret'],token:'opaque'}}, true, false],
  ['missing', {clientSecret:''}, false, true],
  ['replacement', {clientSecret:'${ROCKETRIDE_NEW_SECRET}', secureParameters:{secure:['clientSecret'],token:'opaque'}}, true, false],
  ['invalid replacement', {clientSecret:'plaintext', secureParameters:{secure:['clientSecret'],token:'opaque'}}, false, false],
];
for (const [index, [name, data, expectedValid, expectedRequired]] of cases.entries()) {
  const effectiveSchema = removeRequired(schema, getSecuredFormData(data));
  const valid = validateFormData(effectiveSchema, data).errors.length === 0;
  const required = effectiveSchema.required.includes('clientSecret');
  if (valid !== expectedValid || required !== expectedRequired) {
    console.error(`Case ${index + 1} (${name}): expected valid=${expectedValid} and required=${expectedRequired}, got valid=${valid} and required=${required}`);
    process.exitCode = 1;
  }
}
"""
    result = subprocess.run(
        ['node', '--require', str(TSX), '-e', script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
