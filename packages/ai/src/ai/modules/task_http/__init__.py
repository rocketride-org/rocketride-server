from typing import Dict, Any
from ai.web import WebServer
from .task_exec import task_Execute
from .task_data import task_Data, task_Process
from .task_cancel import task_Cancel
from .task_status import task_Status


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the module by registering API routes related to pipe management.
    """
    # Preferred routes (POST)
    server.add_route('/task', task_Execute, methods=['POST'])
    server.add_route('/task/data', task_Data, methods=['POST'])
    server.add_route('/task', task_Status, methods=['GET'])
    server.add_route('/task', task_Cancel, methods=['DELETE'])

    # Alias to /task/data
    server.add_route('/webhook', task_Data, methods=['POST'])

    # Deprecated routes (PUT) - kept for backward compatibility
    server.add_route('/task', task_Execute, methods=['PUT'], deprecated=True)
    server.add_route('/task/process', task_Process, methods=['PUT'], deprecated=True)
