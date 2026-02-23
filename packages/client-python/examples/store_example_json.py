#!/usr/bin/env python3
"""
Simple example demonstrating apaext_store with --project-json parameter.

This shows the correct pipeline structure format for inline JSON usage.
"""

import json
import os
import subprocess

# Path to run_cli.py (in the same directory as this script)
_script_dir = os.path.dirname(os.path.abspath(__file__))
_run_cli_path = os.path.join(_script_dir, 'run_cli.py')


def run_store_command(*args):
    """Run an apaext_store command."""
    cmd = ['python', _run_cli_path, 'apaext_store'] + list(args)
    print(f'\nCommand: {" ".join(cmd)}\n')
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    print(f'Exit code: {result.returncode}')
    if result.stdout:
        print(f'Output:\n{result.stdout}')
    if result.stderr:
        print(f'Stderr:\n{result.stderr}')
    return result.returncode


def main():
    """Demonstrate apaext_store with inline JSON."""
    # Define your API key (replace with actual key)
    apikey = 'YOUR_API_KEY_HERE'

    # Example 1: Save project with inline JSON
    print('=' * 70)
    print('Example 1: Save project with --project-json')
    print('=' * 70)

    pipeline = {
        'name': 'My Demo Pipeline',
        'description': 'Example pipeline for store demonstration',
        'source': 'source_1',
        'components': [
            {'id': 'source_1', 'provider': 'filesystem', 'config': {'mode': 'Source', 'name': 'Local Files', 'path': '/data/input'}},
            {'id': 'processor_1', 'provider': 'ai_chat', 'config': {'model': 'gpt-4'}, 'input': [{'lane': 'output', 'from': 'source_1'}]},
        ],
    }

    # Convert to JSON string
    pipeline_json = json.dumps(pipeline)

    # Save project with inline JSON
    run_store_command('save_project', '--apikey', apikey, '--project-id', 'demo-project-001', '--project-json', pipeline_json)

    # Example 2: Get the saved project
    print('\n' + '=' * 70)
    print('Example 2: Get project')
    print('=' * 70)

    run_store_command('get_project', '--apikey', apikey, '--project-id', 'demo-project-001')

    # Example 3: Update with modified pipeline
    print('\n' + '=' * 70)
    print('Example 3: Update project with --project-json')
    print('=' * 70)

    # Add another source component
    pipeline['components'].append({'id': 'source_2', 'provider': 's3', 'config': {'mode': 'Source', 'name': 'S3 Bucket', 'bucket': 'my-data-bucket', 'prefix': 'input/'}})

    pipeline['description'] = 'Updated with S3 source'

    pipeline_json = json.dumps(pipeline)

    run_store_command('save_project', '--apikey', apikey, '--project-id', 'demo-project-001', '--project-json', pipeline_json)

    # Example 4: List all projects
    print('\n' + '=' * 70)
    print('Example 4: List all projects')
    print('=' * 70)

    run_store_command('get_all_projects', '--apikey', apikey)

    # Example 5: Delete project
    print('\n' + '=' * 70)
    print('Example 5: Delete project')
    print('=' * 70)

    run_store_command('delete_project', '--apikey', apikey, '--project-id', 'demo-project-001')

    # ================================================================
    # Log Examples
    # ================================================================

    # Example 6: Save a log file
    print('\n' + '=' * 70)
    print('Example 6: Save a log file')
    print('=' * 70)

    log_contents = {
        'type': 'event',
        'seq': 1,
        'event': 'apaevt_status_update',
        'body': {
            'name': 'source_1',
            'project_id': 'demo-project-001',
            'source': 'source_1',
            'completed': True,
            'state': 5,
            'startTime': 1764337626.6564875,
            'endTime': 1764337716.5507987,
            'status': 'Completed',
            'totalCount': 100,
            'completedCount': 100,
            'failedCount': 0,
            'errors': [],
            'warnings': [],
        },
    }

    log_json = json.dumps(log_contents)
    run_store_command('save_log', '--apikey', apikey, '--project-id', 'demo-project-001', '--source', 'source_1', '--contents-json', log_json)

    # Example 7: List all logs for a project
    print('\n' + '=' * 70)
    print('Example 7: List all logs for a project')
    print('=' * 70)

    run_store_command('list_logs', '--apikey', apikey, '--project-id', 'demo-project-001')

    # Example 8: List logs filtered by source
    print('\n' + '=' * 70)
    print('Example 8: List logs filtered by source')
    print('=' * 70)

    run_store_command('list_logs', '--apikey', apikey, '--project-id', 'demo-project-001', '--source', 'source_1')

    # Example 9: Get a specific log
    print('\n' + '=' * 70)
    print('Example 9: Get a specific log')
    print('=' * 70)

    run_store_command('get_log', '--apikey', apikey, '--project-id', 'demo-project-001', '--source', 'source_1', '--start-time', str(log_contents['body']['startTime']))

    print('\n' + '=' * 70)
    print('Demo completed!')
    print('=' * 70)
    print('\nNote: Replace YOUR_API_KEY_HERE with an actual API key to run this example.')


if __name__ == '__main__':
    main()
