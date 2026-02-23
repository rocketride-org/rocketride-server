from typing import Any, Dict, List
from collections import deque
from ai.web import AccountInfo
from rocketlib import getServiceDefinition


class AccountPipelineValidation:
    def validate(self, account_info: AccountInfo, pipeline: Dict[str, Any]) -> bool:
        """
        Validate the user has the correct plan for a pipeline.
        """
        required_plans = self._get_pipeline_required_plans(pipeline)

        # Check if user has required plan for pipeline
        if len(required_plans):
            account_plans = set(account_info.plans)
            for required_plan in required_plans:
                if required_plan not in account_plans:
                    return False

        return True

    def _get_pipeline_required_plans(self, pipeline: Dict[str, Any]) -> set:
        """
        Get all required plans for pipeline.
        """
        required_plans = set()

        source = pipeline.get('source')
        if not source:
            return required_plans

        components = pipeline.get('components', [])
        if not components:
            return required_plans

        nodes = {component['id']: component for component in components}
        node_children: Dict[str, List[str]] = {}

        # Build node traversal maps
        for component in components:
            for lane in component.get('input', []):
                node_children.setdefault(lane['from'], []).append(component['id'])

        visited = set()
        queue = deque([source])

        # BFS traversal collecting plans from components in source path
        while queue:
            id = queue.popleft()
            if id in visited:
                continue

            visited.add(id)

            node = nodes.get(id)
            schema = getServiceDefinition(node.get('provider'))
            plans = schema.get('plans', [])
            required_plans = required_plans | set(plans)

            queue.extend(node_children.get(id, []))

        return required_plans
