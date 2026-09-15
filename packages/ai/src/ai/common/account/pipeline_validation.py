# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

from typing import Any, Dict, List
from collections import deque
from ai.web import AccountInfo
from rocketlib import getServiceDefinition


class AccountPipelineValidation:
    def validate(self, account_info: AccountInfo, pipeline: Dict[str, Any]) -> bool:
        """
        Validate the user has the correct plan for a pipeline.

        Plans are a SaaS commerce concept: the SaaS account object carries a
        ``plans`` list, while the shared AccountInfo has no such field. An
        absent attribute (OSS/standalone) therefore means plan gating does
        not apply and the pipeline validates.
        """
        required_plans = self._get_pipeline_required_plans(pipeline)

        # Check if user has required plan for pipeline
        if len(required_plans):
            # Absent attribute = no plan concept (OSS) -> allow. An empty
            # list on SaaS is a real "holds no plans" and still denies.
            plans = getattr(account_info, 'plans', None)
            if plans is None:
                return True
            account_plans = set(plans)
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
            if node is None:
                continue
            schema = getServiceDefinition(node.get('provider'))
            if schema is None:
                continue
            plans = schema.get('plans', [])
            required_plans = required_plans | set(plans)

            queue.extend(node_children.get(id, []))

        return required_plans
