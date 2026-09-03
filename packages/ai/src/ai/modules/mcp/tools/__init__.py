# Copyright 2026 Aparavi Software AG. MIT License.
"""Tool registration entry point for the MCP tool surface.

``register_all(registry)`` populates one shared ``ToolRegistry`` (built once
in ``handlers.build_mcp_server``) by calling each tool module's own
``register(registry)``. Add a new tool group by importing its module here
and calling its ``register(registry)`` from ``register_all``.
"""

from ..tooling import ToolRegistry
from . import capability
from . import execution
from . import integrations
from . import introspection
from . import logs
from . import scaffold
from . import visibility


def register_all(registry: ToolRegistry) -> None:
    """Register every tool module's tools against ``registry``.

    Wires the introspection tools (`list_components`, `describe_component`,
    `validate_pipeline`, `describe_pipeline`), the execution tools
    (`run_pipeline`, `run_dropper_pipe`, `send_data`, `terminate`,
    `send_files`), the capability
    tools (`store_read`, `store_list`, `store_stat`, `store_get_url`,
    `save_template`, `load_template`, `deploy_add`, `deploy_list`,
    `deploy_status`, `deploy_remove`, `deploy_update`), the visibility tools
    (`monitor`, `list_running_pipelines`), the DVR run-log tools
    (`log_chapters`, `log_read`, `log_traces`, `log_trace`), the node
    scaffolding tool (`scaffold_node`), and the
    integration-discovery tool (`list_integrations`) -- registered last so
    it always trails the surface it discovers.
    """
    introspection.register(registry)
    execution.register(registry)
    capability.register(registry)
    visibility.register(registry)
    logs.register(registry)
    scaffold.register(registry)
    integrations.register(registry)
