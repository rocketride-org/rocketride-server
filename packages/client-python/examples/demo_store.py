#!/usr/bin/env python3
"""
Demo script for apaext_store command.

This script demonstrates the usage of the apaext_store command for
managing project storage with atomic operations.

Usage:
    python demo_store.py --apikey YOUR_API_KEY
    python demo_store.py --apikey YOUR_API_KEY --uri http://localhost:8080
    # or set ROCKETRIDE_APIKEY and ROCKETRIDE_URI environment variables
"""

import argparse
import json
import subprocess
import sys
import tempfile
import os

# Global variables to store auth info for subprocess calls
_apikey = None
_uri = None

# Path to run_cli.py (in the same directory as this script)
_script_dir = os.path.dirname(os.path.abspath(__file__))
_run_cli_path = os.path.join(_script_dir, 'run_cli.py')


def run_store_command(subcommand, *args):
    """Run an apaext_store command and return the parsed JSON response."""
    cmd = ['python', _run_cli_path, 'apaext_store', subcommand]

    # Add apikey and uri after subcommand (required by argparse structure)
    if _apikey:
        cmd.extend(['--apikey', _apikey])
    if _uri:
        cmd.extend(['--uri', _uri])

    cmd.extend(list(args))

    print(f'\nRunning: {" ".join(cmd)}')
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)

    print(f'Exit code: {result.returncode}')
    print(f'Output: {result.stdout}')
    if result.stderr:
        print(f'Stderr: {result.stderr}', file=sys.stderr)

    try:
        return json.loads(result.stdout), result.returncode
    except json.JSONDecodeError:
        # Some commands return plain text - create synthetic response
        output = result.stdout.strip()
        if result.returncode == 0:
            # Success with plain text
            return {'success': True, 'message': output}, result.returncode
        else:
            # Error with plain text - parse error type from message
            error_type = 'UNKNOWN'
            if 'not found' in output.lower() or 'File not found' in output:
                error_type = 'NOT_FOUND'
            elif 'version mismatch' in output.lower():
                error_type = 'VERSION_MISMATCH'
            return {'success': False, 'error': error_type, 'message': output}, result.returncode


def demo_store_operations():
    """Demonstrate all store operations."""
    # Setup: Use a temporary directory for testing
    with tempfile.TemporaryDirectory() as tmpdir:
        # Set environment variables for filesystem storage
        os.environ['STORE_URL'] = f'filesystem://{tmpdir}'

        print('=' * 70)
        print('Demonstrating RocketRide Store Command')
        print('=' * 70)
        print(f'Storage URL: {os.environ["STORE_URL"]}')

        test_project_id = 'test-project-001'

        # Demo 1: Save a new project
        print('\n' + '=' * 70)
        print('Demo 1: Save a new project')
        print('=' * 70)

        pipeline_data = {
            'source': 'source_1',
            'pipeline': {
                'name': 'Test Project',
                'description': 'A test project for store operations',
                'components': [
                    {'id': 'source_1', 'provider': 'filesystem', 'config': {'mode': 'Source', 'name': 'Filesystem Source', 'path': '/data/source1'}},
                    {'id': 'source_2', 'provider': 's3', 'config': {'mode': 'Source', 'name': 'S3 Source', 'bucket': 'my-bucket'}},
                ],
            },
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(pipeline_data, f, indent=2)
            pipeline_file = f.name

        try:
            response, _ = run_store_command('save_project', '--project-id', test_project_id, '--project-file', pipeline_file)

            if response and response.get('success'):
                print('✓ Project saved successfully')
                version1 = response.get('version')
                print(f'  Version: {version1}')
            else:
                print('✗ Failed to save project')
                return False
        finally:
            os.unlink(pipeline_file)

        # Demo 2: Get the project
        print('\n' + '=' * 70)
        print('Demo 2: Get the project')
        print('=' * 70)

        response, _ = run_store_command('get_project', '--project-id', test_project_id)

        if response and response.get('success'):
            print('✓ Project retrieved successfully')
            pipeline = response.get('pipeline')
            print(f'  Name: {pipeline.get("name")}')
            sources = [c for c in pipeline.get('pipeline', {}).get('components', []) if c.get('config', {}).get('mode') == 'Source']
            print(f'  Sources: {len(sources)} source(s)')
        else:
            print('✗ Failed to get project')
            return False

        # Demo 3: Update the project
        print('\n' + '=' * 70)
        print('Demo 3: Update the project')
        print('=' * 70)

        pipeline_data['description'] = 'Updated description'
        pipeline_data['pipeline']['components'].append({'id': 'source_3', 'provider': 'azure', 'config': {'mode': 'Source', 'name': 'Azure Source', 'container': 'data'}})

        pipeline_json = json.dumps(pipeline_data)
        response, _ = run_store_command('save_project', '--project-id', test_project_id, '--project-json', pipeline_json)

        if response and response.get('success'):
            print('✓ Project updated successfully')
            version2 = response.get('version')
            print(f'  New Version: {version2}')
            print(f'  Version changed: {version1 != version2}')
        else:
            print('✗ Failed to update project')
            return False

        # Demo 4: Create another project
        print('\n' + '=' * 70)
        print('Demo 4: Create another project')
        print('=' * 70)

        project_data2 = {'id': 'test-project-002', 'pipeline': {'name': 'Second Test Project', 'components': []}}

        project_json = json.dumps(project_data2)
        response, code = run_store_command('save_project', '--project-id', 'test-project-002', '--project-json', project_json)

        if response and response.get('success'):
            print('✓ Second project saved successfully')
            project2_version = response.get('version')
            print(f'  Version: {project2_version}')
        else:
            print('✗ Failed to save second project')
            return False

        # Demo 5: Get all projects
        print('\n' + '=' * 70)
        print('Demo 5: Get all projects')
        print('=' * 70)

        response, code = run_store_command('get_all_projects')

        if response and response.get('success'):
            projects = response.get('projects', [])
            count = response.get('count', 0)
            print(f'✓ Retrieved {count} project(s)')
            for proj in projects:
                print(f'  - {proj.get("id")}: {proj.get("name")} ({len(proj.get("sources", []))} sources, {proj.get("totalComponents", 0)} total components)')

            # Verify our test projects are present
            project_ids = [p.get('id') for p in projects]
            if test_project_id not in project_ids:
                print(f'✗ Expected {test_project_id} in projects list')
                return False
            if 'test-project-002' not in project_ids:
                print('✗ Expected test-project-002 in projects list')
                return False
            print('✓ Both test projects found in list')
        else:
            print('✗ Failed to get all projects')
            return False

        # Demo 6: Delete a project (requires expected-version for atomic delete)
        print('\n' + '=' * 70)
        print('Demo 6: Delete a project')
        print('=' * 70)

        response, code = run_store_command('delete_project', '--project-id', 'test-project-002', '--expected-version', project2_version)

        if response and response.get('success'):
            print('✓ Project deleted successfully')
        else:
            print('✗ Failed to delete project')
            return False

        # Demo 7: Verify deletion
        print('\n' + '=' * 70)
        print('Demo 7: Verify deletion')
        print('=' * 70)

        response, code = run_store_command('get_all_projects')

        if response and response.get('success'):
            projects = response.get('projects', [])
            project_ids = [p.get('id') for p in projects]

            # Verify test-project-002 is deleted and test-project-001 still exists
            if 'test-project-002' in project_ids:
                print('✗ test-project-002 should have been deleted')
                return False
            if test_project_id not in project_ids:
                print(f'✗ {test_project_id} should still exist')
                return False
            print(f'✓ Verified: test-project-002 deleted, {test_project_id} still exists')
        else:
            print('✗ Failed to verify deletion')
            return False

        # Demo 8: Try to get a non-existent project
        print('\n' + '=' * 70)
        print('Demo 8: Try to get a non-existent project')
        print('=' * 70)

        response, code = run_store_command('get_project', '--project-id', 'non-existent')

        if response and not response.get('success'):
            error = response.get('error')
            if error == 'NOT_FOUND':
                print('✓ Correctly returned NOT_FOUND error')
            else:
                print(f'✗ Expected NOT_FOUND, got {error}')
                return False
        else:
            print('✗ Expected error, got success')
            return False

        # ================================================================
        # Log Operations Demos
        # ================================================================

        # Demo 9: Save a log file
        print('\n' + '=' * 70)
        print('Demo 9: Save a log file')
        print('=' * 70)

        log_contents = {
            'type': 'event',
            'seq': 79,
            'event': 'apaevt_status_update',
            'body': {
                'name': 'source_1',
                'project_id': test_project_id,
                'source': 'source_1',
                'completed': True,
                'state': 5,
                'startTime': 1764337626.6564875,
                'endTime': 1764337716.5507987,
                'status': 'Completed',
                'totalCount': 15,
                'completedCount': 15,
                'failedCount': 0,
                'errors': [],
                'warnings': [],
            },
        }

        log_json = json.dumps(log_contents)
        response, code = run_store_command('save_log', '--project-id', test_project_id, '--source', 'source_1', '--contents-json', log_json)

        if response and response.get('success'):
            print('✓ Log saved successfully')
            print(f'  Filename: {response.get("filename")}')
        else:
            print('✗ Failed to save log')
            return False

        # Demo 10: Save another log for the same source (different time)
        print('\n' + '=' * 70)
        print('Demo 10: Save another log (different start time)')
        print('=' * 70)

        log_contents2 = log_contents.copy()
        log_contents2['body'] = log_contents['body'].copy()
        log_contents2['body']['startTime'] = 1764337800.0
        log_contents2['body']['status'] = 'Running'
        log_contents2['body']['completed'] = False

        log_json2 = json.dumps(log_contents2)
        response, code = run_store_command('save_log', '--project-id', test_project_id, '--source', 'source_1', '--contents-json', log_json2)

        if response and response.get('success'):
            print('✓ Second log saved successfully')
            print(f'  Filename: {response.get("filename")}')
        else:
            print('✗ Failed to save second log')
            return False

        # Demo 11: Save log for a different source
        print('\n' + '=' * 70)
        print('Demo 11: Save log for a different source')
        print('=' * 70)

        log_contents3 = log_contents.copy()
        log_contents3['body'] = log_contents['body'].copy()
        log_contents3['body']['source'] = 'source_2'
        log_contents3['body']['startTime'] = 1764337900.0

        log_json3 = json.dumps(log_contents3)
        response, code = run_store_command('save_log', '--project-id', test_project_id, '--source', 'source_2', '--contents-json', log_json3)

        if response and response.get('success'):
            print('✓ Log for source_2 saved successfully')
        else:
            print('✗ Failed to save log for source_2')
            return False

        # Demo 12: List all logs
        print('\n' + '=' * 70)
        print('Demo 12: List all logs for project')
        print('=' * 70)

        response, code = run_store_command('list_logs', '--project-id', test_project_id)

        if response and response.get('success'):
            logs = response.get('logs', [])
            count = response.get('count', 0)
            total_count = response.get('total_count', 0)
            print(f'✓ Retrieved {count} log(s) (total: {total_count})')
            for log in logs:
                print(f'  - {log}')

            # Verify our test logs are present (check for source prefixes)
            source1_logs = [log for log in logs if log.startswith('source_1-')]
            source2_logs = [log for log in logs if log.startswith('source_2-')]
            if len(source1_logs) < 2:
                print(f'✗ Expected at least 2 logs for source_1, found {len(source1_logs)}')
                return False
            if len(source2_logs) < 1:
                print(f'✗ Expected at least 1 log for source_2, found {len(source2_logs)}')
                return False
            print('✓ All expected logs found')
        else:
            print('✗ Failed to list logs')
            return False

        # Demo 13: List logs filtered by source
        print('\n' + '=' * 70)
        print('Demo 13: List logs filtered by source')
        print('=' * 70)

        response, code = run_store_command('list_logs', '--project-id', test_project_id, '--source', 'source_1')

        if response and response.get('success'):
            logs = response.get('logs', [])
            count = response.get('count', 0)
            print(f'✓ Retrieved {count} log(s) for source_1')
            for log in logs:
                print(f'  - {log}')

            # Verify all logs are for source_1 and we have at least 2
            if count < 2:
                print(f'✗ Expected at least 2 logs for source_1, got {count}')
                return False
            non_source1 = [log for log in logs if not log.startswith('source_1-')]
            if non_source1:
                print(f'✗ Found logs not belonging to source_1: {non_source1}')
                return False
            print('✓ Filter working correctly')
        else:
            print('✗ Failed to list logs for source_1')
            return False

        # Demo 14: Get a specific log
        print('\n' + '=' * 70)
        print('Demo 14: Get a specific log')
        print('=' * 70)

        response, code = run_store_command('get_log', '--project-id', test_project_id, '--source', 'source_1', '--start-time', str(log_contents['body']['startTime']))

        if response and response.get('success'):
            contents = response.get('contents', {})
            print('✓ Log retrieved successfully')
            print(f'  Status: {contents.get("body", {}).get("status")}')
            print(f'  Completed: {contents.get("body", {}).get("completed")}')
        else:
            print('✗ Failed to get log')
            return False

        # Demo 15: Try to get a non-existent log
        print('\n' + '=' * 70)
        print('Demo 15: Try to get a non-existent log')
        print('=' * 70)

        response, code = run_store_command('get_log', '--project-id', test_project_id, '--source', 'source_1', '--start-time', '9999999999.0')

        if response and not response.get('success'):
            error = response.get('error')
            if error == 'NOT_FOUND':
                print('✓ Correctly returned NOT_FOUND error')
            else:
                print(f'✗ Expected NOT_FOUND, got {error}')
                return False
        else:
            print('✗ Expected error, got success')
            return False

        print('\n' + '=' * 70)
        print('All demos completed successfully! ✓')
        print('=' * 70)
        return True


if __name__ == '__main__':
    # Parse command line arguments
    parser = argparse.ArgumentParser(description='Demo script for apaext_store command')
    parser.add_argument(
        '--apikey',
        default=os.environ.get('ROCKETRIDE_APIKEY'),
        help='API key for authentication (or set ROCKETRIDE_APIKEY env var)',
    )
    parser.add_argument(
        '--uri',
        default=os.environ.get('ROCKETRIDE_URI'),
        help='Server URI (or set ROCKETRIDE_URI env var, default: https://eaas.rocketlib.com)',
    )
    args = parser.parse_args()

    # Set global variables for subprocess calls
    _apikey = args.apikey
    _uri = args.uri

    if not _apikey:
        print('Warning: No API key provided. Set --apikey or ROCKETRIDE_APIKEY environment variable.')
        print('Demo will use filesystem storage locally.\n')
    if _uri:
        print(f'Using server: {_uri}')

    success = demo_store_operations()
    sys.exit(0 if success else 1)
