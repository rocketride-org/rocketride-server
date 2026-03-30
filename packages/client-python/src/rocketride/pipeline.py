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

"""
Programmatic Pipeline Builder for RocketRide.

This module provides a fluent API for constructing RocketRide pipelines
without manually editing JSON. Pipelines built with this API produce valid
.pipe JSON that the RocketRide engine can execute.

Quick Start::

    from rocketride import Pipeline

    pipeline = Pipeline()
    pipeline.add_node('webhook_1', 'webhook', source=True)
    pipeline.add_node('parse_1', 'parse')
    pipeline.connect('webhook_1', 'parse_1', lane='tags')
    pipeline.add_node('response_1', 'response_text', config={'laneName': 'text'})
    pipeline.connect('parse_1', 'response_1', lane='text')

    # Export to .pipe JSON
    json_str = pipeline.to_json()

    # Save to file
    pipeline.to_file('my_pipeline.pipe')

    # Load from existing file
    loaded = Pipeline.from_file('existing.pipe')

Fluent chaining::

    pipeline = (
        Pipeline()
        .add_node('chat_1', 'chat', source=True)
        .add_node(
            'llm_1',
            'llm_openai',
            config={
                'profile': 'openai-5',
                'openai-5': {'apikey': '${ROCKETRIDE_OPENAI_KEY}'},
            },
        )
        .connect('chat_1', 'llm_1', lane='questions')
        .add_node('response_1', 'response_answers', config={'laneName': 'answers'})
        .connect('llm_1', 'response_1', lane='answers')
    )
"""

from __future__ import annotations

import json
import uuid
from collections import deque
from typing import Any, Optional


# Source component providers that require special config
_SOURCE_PROVIDERS = frozenset(
    {
        'webhook',
        'chat',
        'dropper',
    }
)


class PipelineValidationError(Exception):
    """Raised when pipeline validation fails."""


class Pipeline:
    """Fluent builder for constructing RocketRide .pipe pipeline definitions.

    A Pipeline manages a directed graph of components (nodes) connected by
    typed data lanes. It can export to the .pipe JSON format consumed by
    the RocketRide engine and validate the graph for common errors.

    Attributes:
        project_id: Unique GUID identifying this pipeline.
    """

    def __init__(self, *, project_id: Optional[str] = None) -> None:
        """Create a new empty pipeline.

        Args:
            project_id: Optional UUID for the pipeline. If not provided,
                a new UUID is generated automatically.
        """
        self.project_id: str = project_id or str(uuid.uuid4())
        self._nodes: dict[str, dict[str, Any]] = {}
        self._node_order: list[str] = []
        self._source_id: Optional[str] = None
        self._viewport: dict[str, Any] = {'x': 0, 'y': 0, 'zoom': 1}

    # ------------------------------------------------------------------
    # Node management
    # ------------------------------------------------------------------

    def add_node(
        self,
        node_id: str,
        provider: str,
        *,
        config: Optional[dict[str, Any]] = None,
        source: bool = False,
    ) -> 'Pipeline':
        """Add a component node to the pipeline.

        Args:
            node_id: Unique identifier for this node (e.g. ``"llm_1"``).
            provider: Component provider type (e.g. ``"llm_openai"``, ``"parse"``).
            config: Provider-specific configuration dict. For source nodes with
                providers in (webhook, chat, dropper) the required source fields
                are added automatically if missing.
            source: If True, marks this node as the pipeline entry point.

        Returns:
            self, for fluent chaining.

        Raises:
            ValueError: If ``node_id`` already exists or a second source is added.
        """
        if node_id in self._nodes:
            raise ValueError(f"Node '{node_id}' already exists in the pipeline")

        if source and self._source_id is not None:
            raise ValueError(f"Pipeline already has a source node '{self._source_id}'. Cannot add '{node_id}' as a second source.")

        node_config = dict(config) if config else {}

        # Auto-populate required source config fields
        if source or provider in _SOURCE_PROVIDERS:
            node_config.setdefault('hideForm', True)
            node_config.setdefault('mode', 'Source')
            node_config.setdefault('parameters', {})
            node_config.setdefault('type', provider)
            self._source_id = node_id

        component: dict[str, Any] = {
            'id': node_id,
            'provider': provider,
            'config': node_config,
        }

        self._nodes[node_id] = component
        self._node_order.append(node_id)
        return self

    def configure_node(self, node_id: str, config: dict[str, Any]) -> 'Pipeline':
        """Update configuration of an existing node (shallow merge).

        Args:
            node_id: ID of the node to configure.
            config: Configuration dict to merge into the existing config.

        Returns:
            self, for fluent chaining.

        Raises:
            KeyError: If the node does not exist.
        """
        if node_id not in self._nodes:
            raise KeyError(f"Node '{node_id}' not found in the pipeline")

        self._nodes[node_id]['config'].update(config)
        return self

    def remove_node(self, node_id: str) -> 'Pipeline':
        """Remove a node and all its connections from the pipeline.

        Args:
            node_id: ID of the node to remove.

        Returns:
            self, for fluent chaining.

        Raises:
            KeyError: If the node does not exist.
        """
        if node_id not in self._nodes:
            raise KeyError(f"Node '{node_id}' not found in the pipeline")

        del self._nodes[node_id]
        self._node_order.remove(node_id)

        if self._source_id == node_id:
            self._source_id = None

        # Remove connections referencing this node
        for component in self._nodes.values():
            if 'input' in component:
                component['input'] = [inp for inp in component['input'] if inp['from'] != node_id]
                if not component['input']:
                    del component['input']

            if 'control' in component:
                component['control'] = [ctrl for ctrl in component['control'] if ctrl['from'] != node_id]
                if not component['control']:
                    del component['control']

        return self

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    def connect(
        self,
        source_id: str,
        target_id: str,
        *,
        lane: str = 'text',
    ) -> 'Pipeline':
        """Connect two nodes with a data lane.

        Args:
            source_id: ID of the upstream node that produces data.
            target_id: ID of the downstream node that consumes data.
            lane: Data lane type (e.g. ``"text"``, ``"tags"``, ``"questions"``,
                ``"answers"``, ``"documents"``, ``"image"``).

        Returns:
            self, for fluent chaining.

        Raises:
            KeyError: If either node does not exist.
        """
        if source_id not in self._nodes:
            raise KeyError(f"Source node '{source_id}' not found in the pipeline")
        if target_id not in self._nodes:
            raise KeyError(f"Target node '{target_id}' not found in the pipeline")

        target = self._nodes[target_id]
        if 'input' not in target:
            target['input'] = []

        target['input'].append({'lane': lane, 'from': source_id})
        return self

    def connect_control(
        self,
        source_id: str,
        target_id: str,
        *,
        class_type: str = 'llm',
    ) -> 'Pipeline':
        """Add a control-flow connection between two nodes.

        Args:
            source_id: ID of the upstream node.
            target_id: ID of the downstream node.
            class_type: Control channel type (e.g. ``"llm"``, ``"tool"``, ``"memory"``).

        Returns:
            self, for fluent chaining.

        Raises:
            KeyError: If either node does not exist.
        """
        if source_id not in self._nodes:
            raise KeyError(f"Source node '{source_id}' not found in the pipeline")
        if target_id not in self._nodes:
            raise KeyError(f"Target node '{target_id}' not found in the pipeline")

        target = self._nodes[target_id]
        if 'control' not in target:
            target['control'] = []

        target['control'].append({'classType': class_type, 'from': source_id})
        return self

    def disconnect(
        self,
        source_id: str,
        target_id: str,
        *,
        lane: Optional[str] = None,
    ) -> 'Pipeline':
        """Remove data-lane connections from *source_id* to *target_id*.

        Args:
            source_id: Upstream node ID.
            target_id: Downstream node ID.
            lane: If provided, only remove connections on this lane.
                If None, remove all connections from source to target.

        Returns:
            self, for fluent chaining.
        """
        if target_id not in self._nodes:
            return self

        target = self._nodes[target_id]
        if 'input' not in target:
            return self

        target['input'] = [inp for inp in target['input'] if not (inp['from'] == source_id and (lane is None or inp['lane'] == lane))]

        if not target['input']:
            del target['input']

        return self

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Return the pipeline as an ordered dict matching .pipe JSON format.

        The ``components`` key always appears first, followed by ``project_id``,
        ``viewport``, and ``version`` at the bottom, as required by the RocketRide
        engine.
        """
        components = [self._nodes[nid] for nid in self._node_order]
        result: dict[str, Any] = {'components': components}
        if self._source_id:
            result['source'] = self._source_id
        result['project_id'] = self.project_id
        result['viewport'] = dict(self._viewport)
        result['version'] = 1
        return result

    def to_json(self, *, indent: int = 2) -> str:
        """Serialize the pipeline to a .pipe-compatible JSON string.

        Args:
            indent: JSON indentation level (default 2).

        Returns:
            A JSON string that can be written to a ``.pipe`` file.
        """
        return json.dumps(self.to_dict(), indent=indent)

    def to_file(self, path: str, *, indent: int = 2) -> None:
        """Write the pipeline to a ``.pipe`` file.

        Args:
            path: File path (should end with ``.pipe``).
            indent: JSON indentation level.
        """
        with open(path, 'w', encoding='utf-8') as f:
            f.write(self.to_json(indent=indent))
            f.write('\n')

    # ------------------------------------------------------------------
    # Deserialization
    # ------------------------------------------------------------------

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> 'Pipeline':
        """Create a Pipeline from a dict (parsed .pipe JSON).

        Args:
            data: Dictionary with ``components``, ``project_id``, etc.

        Returns:
            A new Pipeline instance populated from the dict.
        """
        pipeline = cls(project_id=data.get('project_id', str(uuid.uuid4())))
        pipeline._viewport = data.get('viewport', {'x': 0, 'y': 0, 'zoom': 1})
        pipeline._source_id = data.get('source')

        for comp in data.get('components', []):
            node_id = comp['id']
            component = dict(comp)
            pipeline._nodes[node_id] = component
            pipeline._node_order.append(node_id)

            # Detect source node from config
            if component.get('config', {}).get('mode') == 'Source':
                pipeline._source_id = pipeline._source_id or node_id

        return pipeline

    @classmethod
    def from_json(cls, json_str: str) -> 'Pipeline':
        """Create a Pipeline from a JSON string.

        Args:
            json_str: A .pipe-format JSON string.

        Returns:
            A new Pipeline instance.
        """
        return cls.from_dict(json.loads(json_str))

    @classmethod
    def from_file(cls, path: str) -> 'Pipeline':
        """Load a Pipeline from a ``.pipe`` file.

        Args:
            path: Path to the ``.pipe`` file.

        Returns:
            A new Pipeline instance populated from the file.
        """
        with open(path, encoding='utf-8') as f:
            return cls.from_dict(json.load(f))

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def validate(self) -> list[str]:
        """Validate the pipeline graph and return a list of error messages.

        Checks performed:
        - At least one component exists
        - Exactly one source node is defined
        - All input/control ``from`` references point to existing nodes
        - The graph contains no cycles
        - ``project_id`` is present and looks like a UUID

        Returns:
            A list of error strings. An empty list means the pipeline is valid.
        """
        errors: list[str] = []

        if not self._nodes:
            errors.append('Pipeline has no components')
            return errors

        # Check project_id
        if not self.project_id:
            errors.append('Pipeline is missing a project_id')
        else:
            try:
                uuid.UUID(self.project_id)
            except ValueError:
                errors.append(f"project_id '{self.project_id}' is not a valid UUID")

        # Check source node
        source_nodes = [nid for nid, comp in self._nodes.items() if comp.get('config', {}).get('mode') == 'Source']
        if not source_nodes and self._source_id is None:
            errors.append('Pipeline has no source node')
        elif len(source_nodes) > 1:
            errors.append(f'Pipeline has multiple source nodes: {source_nodes}')

        # Check references
        for nid, comp in self._nodes.items():
            for inp in comp.get('input', []):
                if inp['from'] not in self._nodes:
                    errors.append(f"Node '{nid}' references unknown input node '{inp['from']}'")
            for ctrl in comp.get('control', []):
                if ctrl['from'] not in self._nodes:
                    errors.append(f"Node '{nid}' references unknown control node '{ctrl['from']}'")

        # Cycle detection (BFS/Kahn's algorithm)
        in_degree: dict[str, int] = {nid: 0 for nid in self._nodes}
        adjacency: dict[str, list[str]] = {nid: [] for nid in self._nodes}

        for nid, comp in self._nodes.items():
            for inp in comp.get('input', []):
                src = inp['from']
                if src in self._nodes:
                    adjacency[src].append(nid)
                    in_degree[nid] += 1
            for ctrl in comp.get('control', []):
                src = ctrl['from']
                if src in self._nodes:
                    adjacency[src].append(nid)
                    in_degree[nid] += 1

        queue: deque[str] = deque(nid for nid, deg in in_degree.items() if deg == 0)
        visited = 0
        while queue:
            node = queue.popleft()
            visited += 1
            for neighbour in adjacency[node]:
                in_degree[neighbour] -= 1
                if in_degree[neighbour] == 0:
                    queue.append(neighbour)

        if visited != len(self._nodes):
            errors.append('Pipeline graph contains a cycle')

        return errors

    def validate_or_raise(self) -> None:
        """Validate the pipeline and raise if there are errors.

        Raises:
            PipelineValidationError: With all validation error messages joined.
        """
        errors = self.validate()
        if errors:
            raise PipelineValidationError('Pipeline validation failed:\n' + '\n'.join(f'  - {e}' for e in errors))

    # ------------------------------------------------------------------
    # Introspection helpers
    # ------------------------------------------------------------------

    @property
    def node_ids(self) -> list[str]:
        """Return all node IDs in insertion order."""
        return list(self._node_order)

    def get_node(self, node_id: str) -> dict[str, Any]:
        """Return the raw component dict for a node.

        Args:
            node_id: ID of the node.

        Raises:
            KeyError: If the node does not exist.
        """
        if node_id not in self._nodes:
            raise KeyError(f"Node '{node_id}' not found in the pipeline")
        return dict(self._nodes[node_id])

    def __len__(self) -> int:
        """Return the number of nodes in the pipeline."""
        return len(self._nodes)

    def __repr__(self) -> str:
        """Return a developer-friendly string representation."""
        return f"Pipeline(project_id='{self.project_id}', nodes={len(self._nodes)}, source='{self._source_id}')"
