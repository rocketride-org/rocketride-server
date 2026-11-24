# Copyright 2026 Aparavi Software AG. MIT License.
"""Display titles for the MCP tools, keyed by tool name.

Hosts show a tool's title where they would otherwise show its name, including
in the prompt that asks a person to allow a call. ``register_all`` hands this
table to the registry, which sends each title as both ``title`` and
``annotations.title``.

A title starts with a verb, is in sentence case, has no final period, is at
most 40 characters long and is unique. It names no brand, makes no claim such
as "best" or "official", and gives the model no instruction. It is true for
every input the tool accepts, and never makes a tool that changes something
sound like one that only reads. ``tests/test_tool_contract.py`` checks the
rules a test can check and fails for any offered tool without a row here.

A row for a tool that is not registered is ignored.
"""

from typing import Dict

TOOL_TITLES: Dict[str, str] = {
    # introspection
    'list_components': 'List pipeline components ready to use',
    'describe_component': "Get a component's full definition",
    'resolve_config': 'Show the settings a component will use',
    'validate_pipeline': 'Validate a pipeline or try a component',
    'describe_pipeline': "Summarize a pipeline's components",
    # execution
    'run_pipeline': 'Run a pipeline',
    'run_dropper_pipe': 'Run a pipeline and get file upload links',
    'send_data': 'Send data to a running pipeline',
    'terminate': 'Stop a running pipeline',
    'send_files': 'Send local files to a running pipeline',
    # capability: store and templates
    'store_read': 'Read a stored text file',
    'store_list': 'List stored files and folders',
    'store_stat': 'Get details of a stored file or folder',
    'store_get_url': 'Get a download link for a stored file',
    'save_template': 'Save or replace a pipeline template',
    'load_template': 'Get a saved pipeline template',
    # capability: deployments
    'deploy_add': 'Register and optionally deploy a version',
    'deploy_list': 'List pipeline deployments',
    'deploy_status': "Get a deployment's status",
    'deploy_versions': "List a pipeline's versions",
    'deploy_to_team': 'Deploy a pipeline version to a team',
    'deploy_set_schedule': "Set or clear a deployment's schedule",
    'deploy_enable': 'Enable a deployment',
    'deploy_disable': 'Disable a deployment',
    'deploy_remove': 'Remove a deployment',
    # visibility
    'monitor': "Watch a running pipeline's status",
    'list_running_pipelines': 'List running pipelines',
    # logs
    'log_chapters': "List a pipeline's recorded runs",
    'log_read': "Read a pipeline's run log",
    'log_traces': 'List the documents traced in a run',
    'log_trace': "Get one document's full trace",
    # scaffold
    'scaffold_node': 'Draft files for a new custom component',
    # integrations
    'list_integrations': 'Check which integrations are set up',
    # canvas and account
    'view_pipeline': 'Show a saved pipeline as a diagram',
    'account_status': 'Check if your account can run pipelines',
    # component probe
    'probe_component': "Test a component's settings",
}
