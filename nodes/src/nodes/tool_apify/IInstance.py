# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Apify tool node instance.

Exposes ``run_actor`` (run an Actor and return its dataset) and
``get_dataset_items`` (read an existing dataset) as agent tools.
"""

from __future__ import annotations

from datetime import timedelta

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from .IGlobal import IGlobal


def _clamp_limit(value, cap: int) -> int:
    """Coerce an agent-supplied limit to a sane integer within [1, cap]."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = cap
    return max(1, min(n, cap))


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['actor_id'],
            'properties': {
                'actor_id': {
                    'type': 'string',
                    'description': 'Apify Actor ID or name, e.g. "apify/website-content-crawler".',
                },
                'run_input': {
                    'type': 'object',
                    'description': 'Input object passed to the Actor (Actor-specific schema).',
                },
                'limit': {
                    'type': 'integer',
                    'description': 'Max result items to return; capped by the node config.',
                    'default': 100,
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'dataset_id': {'type': 'string'},
                'count': {'type': 'integer'},
                'items': {'type': 'array', 'items': {'type': 'object'}},
            },
        },
        description='Run an Apify Actor to completion and return the items it produced.',
    )
    def run_actor(self, args):
        """Run an Actor and return its dataset items."""
        args = normalize_tool_input(args, tool_name='apify')
        actor_id = args.get('actor_id')
        if not actor_id:
            raise ValueError('run_actor requires an `actor_id` parameter')

        run_input = args.get('run_input') or {}
        limit = _clamp_limit(args.get('limit'), self.IGlobal.max_items)

        # Bound run time, item count and cost so an agent-chosen Actor can't hang or overspend.
        run = self.IGlobal.client.actor(actor_id).call(
            run_input=run_input,
            max_items=limit,
            max_total_charge_usd=self.IGlobal.max_cost_usd,
            run_timeout=timedelta(seconds=self.IGlobal.run_timeout_secs),
            wait_duration=timedelta(seconds=self.IGlobal.run_timeout_secs),
        )
        dataset_id = run.default_dataset_id if run else None
        if not dataset_id:
            return {'success': True, 'dataset_id': '', 'count': 0, 'items': []}

        items = self.IGlobal.client.dataset(dataset_id).list_items(limit=limit).items
        return {'success': True, 'dataset_id': dataset_id, 'count': len(items), 'items': items}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['dataset_id'],
            'properties': {
                'dataset_id': {'type': 'string', 'description': 'Apify dataset ID to read.'},
                'limit': {
                    'type': 'integer',
                    'description': 'Max items to return; capped by the node config.',
                    'default': 100,
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'count': {'type': 'integer'},
                'items': {'type': 'array', 'items': {'type': 'object'}},
            },
        },
        description='Read items from an existing Apify dataset.',
    )
    def get_dataset_items(self, args):
        """Read items from an existing dataset."""
        args = normalize_tool_input(args, tool_name='apify')
        dataset_id = args.get('dataset_id')
        if not dataset_id:
            raise ValueError('get_dataset_items requires a `dataset_id` parameter')

        limit = _clamp_limit(args.get('limit'), self.IGlobal.max_items)
        items = self.IGlobal.client.dataset(dataset_id).list_items(limit=limit).items
        return {'success': True, 'count': len(items), 'items': items}
