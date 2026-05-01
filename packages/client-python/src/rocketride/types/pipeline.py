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
Pipeline Configuration Types for RocketRide Data Processing.

This module defines types for constructing and configuring RocketRide data processing pipelines.
Pipelines are composed of connected components that process data through transformation,
analysis, routing, and AI operations. Understanding these types is essential for building
custom data processing workflows.

Types Defined:
    PipelineComponent: Individual processing unit within a pipeline
    PipelineInputConnection: Data flow connection between components
    PipelineConfig: Complete pipeline configuration with components and execution parameters

Pipeline Architecture:
    Pipelines consist of components connected in a directed graph where data flows
    from input connections through processing components to output destinations.
    Each component:
    - Has a unique ID within the pipeline
    - Specifies a provider type (webhook, ai_chat, response, etc.)
    - Contains provider-specific configuration
    - Declares input connections from other components
    - Processes data and passes results to connected components

Data Flow Model:
    Components receive input on named "lanes" and send output to downstream components.
    The PipelineInputConnection type defines these connections:
    - 'from': Source component ID that provides data
    - 'lane': Named output lane from the source component

    Example flow:
    webhook (source) --> [lane: 'output'] --> ai_chat --> [lane: 'answer'] --> response

Usage:
    from rocketride.types import PipelineComponent, PipelineConfig

    # Define a pipeline configuration
    config: PipelineConfig = {
        'project_id': 'my-project',
        'source': 'webhook_input',
        'components': [
            {
                'id': 'webhook_input',
                'provider': 'webhook',
                'config': {'path': '/api/data'}
            },
            {
                'id': 'ai_processor',
                'provider': 'ai_chat',
                'config': {'model': 'gpt-4'},
                'input': [{'from': 'webhook_input', 'lane': 'output'}]
            },
            {
                'id': 'output',
                'provider': 'response',
                'config': {},
                'input': [{'from': 'ai_processor', 'lane': 'answer'}]
            }
        ]
    }

    # Use the pipeline
    token = await client.use(pipeline=config)
"""

from typing import Any, TypedDict, Optional

# Create TypedDict dynamically to avoid keyword conflict
PipelineInputConnection = TypedDict(
    'PipelineInputConnection',
    {
        'lane': str,  # REQUIRED
        'from': str,  # REQUIRED
    },
)

PipelineControlConnection = TypedDict(
    'PipelineControlConnection',
    {
        'classType': str,  # REQUIRED - Class type of the invoke channel (e.g., 'llm', 'tool', 'memory')
        'from': str,  # REQUIRED - Source component ID providing the invocation
    },
)


class PipelineComponent(TypedDict, total=False):
    """
    Pipeline component that processes data.

    Note: id, provider, and config are required fields.
    """

    id: str  # Unique identifier for this component within the pipeline - REQUIRED
    provider: str  # Component type/provider (e.g., 'webhook', 'response', 'ai_chat') - REQUIRED
    config: dict[str, Any]  # Component-specific configuration parameters - REQUIRED
    name: str  # Human-readable component name
    description: str  # Component description for documentation
    ui: dict[str, Any]  # UI-specific configuration for visual editors
    input: list[PipelineInputConnection]  # Input connections from other components
    control: list[PipelineControlConnection]  # Invoke (control-flow) connections from other components


class PipelineConfig(TypedDict, total=False):
    """
    Pipeline configuration for RocketRide data processing workflows.

    Defines a complete pipeline with components, data flow connections,
    and execution parameters. Pipelines process data through a series
    of connected components that transform, analyze, or route information.
    """

    description: str  # Pipeline description
    version: int  # Pipeline version number
    components: list[PipelineComponent]  # Array of pipeline components - REQUIRED
    source: Optional[str]  # ID of the component that serves as the pipeline entry point
    project_id: str  # Project identifier for organization and permissions
    viewport: dict[str, Any]  # UI viewport settings for visual editors
    docRevision: int  # Editor document revision counter for change tracking
    isLocked: bool  # Whether the canvas is locked from editing
    snapToGrid: bool  # Whether node snapping to grid is enabled
    snapGridSize: list[int]  # Grid size for snapping [x, y]
    editorMode: str  # Active editor mode (e.g. 'design', 'status', 'flow')
