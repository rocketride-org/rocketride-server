from typing import Any, Dict, List
from collections import deque
from ai.web import AccountInfo
from rocketlib import getServiceDefinition


class AccountPipelineValidation:
    def validate(self, account_info: AccountInfo, pipeline: Dict[str, Any]) -> bool:
        """
        Validate the user has the correct subscribed app for a pipeline.

        Fix F-03: was reading account_info.plans which does not exist on
        AccountInfo. The correct field is account_info.subscribedApps, a
        list of SubscribedApp objects with 'appId' and 'status' keys.
        """
        required_plans = self._get_pipeline_required_plans(pipeline)

        if len(required_plans):
            # Build a set of active/trialing subscribed app IDs from the
            # correct AccountInfo field (was incorrectly `account_info.plans`).
            active_statuses = {'active', 'trialing'}
            account_app_ids = {
                s['appId']
                for s in (account_info.subscribedApps or [])
                if s.get('status') in active_statuses
            }
            for required_plan in required_plans:
                if required_plan not in account_app_ids:
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

        for component in components:
            for lane in component.get('input', []):
                node_children.setdefault(lane['from'], []).append(component['id'])

        visited = set()
        queue = deque([source])

        while queue:
            id = queue.popleft()
            if id in visited:
                continue

            visited.add(id)

            node = nodes.get(id)
            if node is None:
                continue
            schema = getServiceDefinition(node.get('provider'))
            if schema is None:
                continue
            plans = schema.get('plans', [])
            required_plans = required_plans | set(plans)

            queue.extend(node_children.get(id, []))

        return required_plans
