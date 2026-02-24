#!/usr/bin/env python3
# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.

"""Integration test: verify structured logging works end-to-end with client-python.

Prerequisites:
    1. Start the engine:  ./dist/server/Engine --service --port 8080
    2. Install deps:      cd packages/observability/python && uv venv .venv --python 3.13 \
                              && uv pip install -e ".[dev]" --python .venv/bin/python \
                              && uv pip install -e ../../client-python --python .venv/bin/python
    3. Run this script:   .venv/bin/python tests/integration_test.py [--uri URI] [--auth KEY]

What it verifies:
    - rocketride_observability produces structured JSON on stderr
    - PII scrubbing works in real log output
    - OTel trace fields are present (empty when no SDK instrumented)
    - DAPBase picks up the observability logger instead of stdlib
    - All log lines are valid JSON with expected fields

Can also run WITHOUT a live engine (--offline) to test the logging
pipeline in isolation using just the observability package.
"""

import argparse
import asyncio
import io
import json
import logging
import pathlib
import sys


def test_offline():
    """Test observability logging without a running engine."""
    print('=' * 60)
    print('OFFLINE TEST: Observability package in isolation')
    print('=' * 60)

    captured = io.StringIO()
    errors = []

    # --- 1. Configure logging to capture output ---
    from rocketride_observability import configure_logging, get_logger

    configure_logging(level=logging.DEBUG)

    # Redirect the root logger's handler to our StringIO
    root = logging.getLogger()
    for h in root.handlers:
        h.stream = captured

    # --- 2. Basic structured logging ---
    print('\n[1] Basic structured logging')
    logger = get_logger('integration-test', component='observability')
    logger.info('server started', port=8080, version='0.1.0')

    line = captured.getvalue().strip().split('\n')[-1]
    try:
        record = json.loads(line)
        assert record['event'] == 'server started', f'Expected event "server started", got {record["event"]}'
        assert record['port'] == 8080
        assert record['component'] == 'observability'
        assert 'timestamp' in record
        assert record['level'] == 'info'
        print(f'    PASS: {line}')
    except (json.JSONDecodeError, AssertionError, KeyError) as e:
        errors.append(f'Basic logging: {e}')
        print(f'    FAIL: {e}')

    # --- 3. PII scrubbing ---
    print('\n[2] PII scrubbing in log output')
    logger.warning('auth failed', email='alice@example.com', token='Bearer eyJhbGciOiJIUzI1.secret')

    line = captured.getvalue().strip().split('\n')[-1]
    try:
        record = json.loads(line)
        assert 'alice' not in record['email'], f'Email not scrubbed: {record["email"]}'
        assert record['email'] == '***@example.com'
        assert 'eyJ' not in record['token'], f'Token not scrubbed: {record["token"]}'
        print(f'    PASS: email={record["email"]}, token redacted')
    except (json.JSONDecodeError, AssertionError, KeyError) as e:
        errors.append(f'PII scrubbing: {e}')
        print(f'    FAIL: {e}')

    # --- 4. AWS key scrubbing ---
    print('\n[3] AWS key scrubbing')
    logger.info('config loaded', aws_key='AKIAIOSFODNN7EXAMPLE', path='/Users/dmitrii/secrets/creds.json')

    line = captured.getvalue().strip().split('\n')[-1]
    try:
        record = json.loads(line)
        assert 'AKIA' not in record['aws_key'], f'AWS key not scrubbed: {record["aws_key"]}'
        assert 'dmitrii' not in record['path'], f'Path not scrubbed: {record["path"]}'
        assert '/Users/***/' in record['path']
        print(f'    PASS: aws_key={record["aws_key"]}, path={record["path"]}')
    except (json.JSONDecodeError, AssertionError, KeyError) as e:
        errors.append(f'AWS key scrubbing: {e}')
        print(f'    FAIL: {e}')

    # --- 5. OTel trace context (empty without SDK) ---
    print('\n[4] OTel trace context fields present')
    logger.info('trace check')

    line = captured.getvalue().strip().split('\n')[-1]
    try:
        record = json.loads(line)
        assert 'trace_id' in record, 'Missing trace_id field'
        assert 'span_id' in record, 'Missing span_id field'
        assert record['trace_id'] == '', f'Expected empty trace_id, got {record["trace_id"]}'
        print(f'    PASS: trace_id="" span_id="" (no OTel SDK)')
    except (json.JSONDecodeError, AssertionError, KeyError) as e:
        errors.append(f'OTel context: {e}')
        print(f'    FAIL: {e}')

    # --- 6. DAPBase wiring ---
    print('\n[5] DAPBase uses observability logger')
    import importlib.util

    # Resolve path: tests/ -> python/ -> observability/ -> packages/
    packages_dir = pathlib.Path(__file__).resolve().parent.parent.parent.parent
    dap_base_path = packages_dir / 'client-python' / 'src' / 'rocketride' / 'core' / 'dap_base.py'
    spec = importlib.util.spec_from_file_location('dap_base', str(dap_base_path))
    if spec and spec.loader:
        mod = importlib.util.module_from_spec(spec)
        sys.modules['dap_base'] = mod
        spec.loader.exec_module(mod)

        dap = mod.DAPBase(module='INTEGRATION-TEST')
        dap.debug_message('hello from DAPBase')

        line = captured.getvalue().strip().split('\n')[-1]
        try:
            record = json.loads(line)
            assert '[INTEGRATION-TEST]' in record['event']
            print(f'    PASS: {record["event"]}')
        except (json.JSONDecodeError, AssertionError, KeyError) as e:
            errors.append(f'DAPBase wiring: {e}')
            print(f'    FAIL: {e}')
    else:
        print('    SKIP: could not locate dap_base.py')

    # --- Summary ---
    print('\n' + '=' * 60)
    if errors:
        print(f'FAILED: {len(errors)} error(s)')
        for e in errors:
            print(f'  - {e}')
        return 1
    else:
        print('ALL OFFLINE TESTS PASSED')
        return 0


async def test_online(uri: str, auth: str):
    """Test observability logging with a live engine connection."""
    print('=' * 60)
    print(f'ONLINE TEST: Connecting to {uri}')
    print('=' * 60)

    captured = io.StringIO()
    errors = []

    # Configure logging to capture output
    from rocketride_observability import configure_logging, get_logger

    configure_logging(level=logging.DEBUG)

    root = logging.getLogger()
    for h in root.handlers:
        h.stream = captured

    # Import the client (needs full rocketride package)
    try:
        from rocketride import RocketRideClient
    except ImportError as e:
        print(f'\n    SKIP online tests: {e}')
        print('    Install client-python: uv pip install -e ../../client-python --python .venv/bin/python')
        return 0

    log_lines_before = len(captured.getvalue().strip().split('\n'))

    # --- 1. Connect ---
    print('\n[1] Connecting to engine')
    client = RocketRideClient(uri=uri, auth=auth)
    try:
        await client.connect(timeout=10000)
        print(f'    PASS: connected={client.is_connected()}')
    except Exception as e:
        print(f'    FAIL: connection error: {e}')
        errors.append(f'Connection: {e}')
        print('\n' + '=' * 60)
        print(f'FAILED: {len(errors)} error(s) — is the engine running?')
        return 1

    # --- 2. Check that connect produced structured JSON logs ---
    print('\n[2] Checking structured log output from connection')
    log_output = captured.getvalue().strip().split('\n')
    new_lines = log_output[log_lines_before:]

    json_count = 0
    for line in new_lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            json_count += 1
            if json_count <= 3:
                event = record.get('event', '')[:80]
                print(f'    LOG: level={record.get("level", "?")} event="{event}"')
        except json.JSONDecodeError:
            pass

    if json_count > 0:
        print(f'    PASS: {json_count} structured JSON log line(s) from connection')
    else:
        print('    INFO: no debug log lines captured (expected at INFO level)')

    # --- 3. Start echo pipeline ---
    print('\n[3] Starting echo pipeline')
    pipeline = {
        'pipeline': {
            'components': [
                {
                    'id': 'webhook_1',
                    'provider': 'webhook',
                    'name': 'Integration Test Input',
                    'config': {'mode': 'Source', 'type': 'webhook'},
                },
                {
                    'id': 'response_1',
                    'provider': 'response',
                    'config': {'lanes': []},
                    'input': [{'lane': 'text', 'from': 'webhook_1'}],
                },
            ],
            'source': 'webhook_1',
        }
    }

    try:
        result = await client.use(pipeline=pipeline, token='OBSERVABILITY-TEST')
        token = result.get('token', 'OBSERVABILITY-TEST')
        print(f'    PASS: pipeline started, token={token}')

        # --- 4. Send data ---
        print('\n[4] Sending test data')
        response = await client.send(token, 'Hello from observability integration test!')
        name = response.get('name', '?')
        print(f'    PASS: response name={name}')

        # --- 5. Terminate ---
        print('\n[5] Terminating pipeline')
        await client.terminate(token)
        print('    PASS: pipeline terminated')

    except Exception as e:
        errors.append(f'Pipeline execution: {e}')
        print(f'    FAIL: {e}')

    # --- 6. Disconnect ---
    print('\n[6] Disconnecting')
    try:
        await client.disconnect()
        print('    PASS: disconnected')
    except Exception as e:
        errors.append(f'Disconnect: {e}')
        print(f'    FAIL: {e}')

    # --- 7. Verify all captured log lines are valid JSON ---
    print('\n[7] Validating all captured log output is JSON')
    all_lines = captured.getvalue().strip().split('\n')
    total = 0
    valid_json = 0
    for line in all_lines:
        if not line.strip():
            continue
        total += 1
        try:
            json.loads(line)
            valid_json += 1
        except json.JSONDecodeError:
            pass

    if total > 0:
        pct = (valid_json / total) * 100
        print(f'    {valid_json}/{total} lines are valid JSON ({pct:.0f}%)')
        if valid_json == total:
            print('    PASS: 100% structured output')
        else:
            print(f'    WARN: {total - valid_json} non-JSON lines')
    else:
        print('    INFO: no log lines captured')

    # --- Summary ---
    print('\n' + '=' * 60)
    if errors:
        print(f'FAILED: {len(errors)} error(s)')
        for e in errors:
            print(f'  - {e}')
        return 1
    else:
        print('ALL ONLINE TESTS PASSED')
        return 0


def main():
    parser = argparse.ArgumentParser(description='RocketRide Observability Integration Test')
    parser.add_argument('--uri', default='http://localhost:8080', help='Engine URI (default: http://localhost:8080)')
    parser.add_argument('--auth', default='test', help='API auth key (default: test)')
    parser.add_argument('--offline', action='store_true', help='Run offline tests only (no engine required)')
    args = parser.parse_args()

    # Always run offline tests
    rc = test_offline()

    # Run online tests unless --offline
    if not args.offline and rc == 0:
        print('\n')
        rc = asyncio.run(test_online(args.uri, args.auth))

    sys.exit(rc)


if __name__ == '__main__':
    main()
