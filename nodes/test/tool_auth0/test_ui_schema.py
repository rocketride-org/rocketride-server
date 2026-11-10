# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Check conditional write requirements with RocketRide's form validator."""

import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
RJSF = ROOT / 'apps' / 'shared' / 'node_modules' / '@rjsf' / 'validator-ajv8'


@pytest.mark.skipif(not RJSF.exists(), reason='RocketRide UI dependencies are not installed')
def test_read_secret_stored_missing_and_replaced():
    """Validate read secrets with the same stored-field handling as the UI."""
    script = r"""
const fs = require('fs');
const { getSecuredFormData, removeRequired, validateFormData } = require('./apps/shared/src/components/node-config/rjsf.ts');
const service = JSON.parse(fs.readFileSync('nodes/src/nodes/tool_auth0/services.json'));
const section = service.shape[0];
const schema = { type: 'object', properties: {
  clientSecret: service.fields['auth0.clientSecret'], secureParameters: {type: 'object'}
}, required: ['clientSecret'], if: section.if, then: section.then };
const cases = [
  ['stored and empty', {clientSecret:'', secureParameters:{secure:['clientSecret'],token:'opaque'}}, true],
  ['missing', {clientSecret:''}, false],
  ['replacement', {clientSecret:'${ROCKETRIDE_NEW_SECRET}', secureParameters:{secure:['clientSecret'],token:'opaque'}}, true],
  ['invalid replacement', {clientSecret:'plaintext', secureParameters:{secure:['clientSecret'],token:'opaque'}}, false],
];
for (const [name, data, expected] of cases) {
  const effectiveSchema = removeRequired(schema, getSecuredFormData(data));
  const valid = validateFormData(effectiveSchema, data).errors.length === 0;
  if (valid !== expected) { console.error(`${name}: expected valid=${expected}, got ${valid}`); process.exitCode = 1; }
}
"""
    result = subprocess.run(
        ['node', '--require', './apps/shared/node_modules/tsx/dist/cjs/index.cjs', '-e', script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(not RJSF.exists(), reason='RocketRide UI dependencies are not installed')
def test_write_fields_required_only_when_enabled():
    """Check conditional write requirements and schema resolution."""
    script = r"""
const fs = require('fs');
const { createSchemaUtils } = require('./apps/shared/node_modules/@rjsf/utils');
const validator = require('./apps/shared/node_modules/@rjsf/validator-ajv8').default;
const { validateFormData } = require('./apps/shared/src/components/node-config/rjsf.ts');
const service = JSON.parse(fs.readFileSync('nodes/src/nodes/tool_auth0/services.json'));
const section = service.shape[0];
const schema = {
  type: 'object',
  properties: { allowWrite: {type: 'boolean'}, writeClientId: {type: 'string'},
    clientSecret: service.fields['auth0.clientSecret'],
    writeClientSecret: service.fields['auth0.writeClientSecret'], secureParameters: {type: 'object'} },
  if: section.if, then: section.then,
};
const readSecret = '${ROCKETRIDE_AUTH0_CLIENT_SECRET}';
const writeSecret = '${ROCKETRIDE_AUTH0_WRITE_CLIENT_SECRET}';
const cases = [
  [{allowWrite:false,clientSecret:readSecret}, true, []],
  [{allowWrite:false,clientSecret:'plaintext'}, false, []],
  [{allowWrite:true,clientSecret:readSecret}, false, ['writeClientId','writeClientSecret']],
  [{allowWrite:true,clientSecret:readSecret,writeClientId:'id',writeClientSecret:writeSecret}, true, ['writeClientId','writeClientSecret']],
  [{allowWrite:true,clientSecret:readSecret,writeClientId:'id',writeClientSecret:'plaintext'}, false, ['writeClientId','writeClientSecret']],
  [{allowWrite:true,clientSecret:readSecret,writeClientId:'id',secureParameters:{secure:['writeClientSecret']}}, true, ['writeClientId']],
  [{allowWrite:true,clientSecret:readSecret,writeClientId:' ',writeClientSecret:' '}, false, ['writeClientId','writeClientSecret']],
];
for (const [index, [data, valid, required]] of cases.entries()) {
  const result = validator.validateFormData(data, schema);
  const canvasResult = validateFormData(schema, data);
  const resolved = createSchemaUtils(validator, schema).retrieveSchema(schema, data);
  if ((result.errors.length === 0) !== valid || (canvasResult.errors.length === 0) !== valid || JSON.stringify(resolved.required || []) !== JSON.stringify(required)) {
    console.error(`Case ${index}: expected valid=${valid}, required=${JSON.stringify(required)}; ` +
      `actual valid=${result.errors.length === 0}, required=${JSON.stringify(resolved.required || [])}; ` +
      `errors=${JSON.stringify(result.errors)}`);
    process.exitCode = 1;
  }
}
"""
    result = subprocess.run(
        ['node', '--require', './apps/shared/node_modules/tsx/dist/cjs/index.cjs', '-e', script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
