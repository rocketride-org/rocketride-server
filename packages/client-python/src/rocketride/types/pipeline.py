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
    SUBMIT_RESULT: What submit() returns: the pipe close body plus the resolution stamps

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

from typing import Any, List, Literal, TypedDict, Optional

# Create TypedDict dynamically to avoid keyword conflict
PipelineInputConnection = TypedDict(
    'PipelineInputConnection',
    {
        'lane': str,  # REQUIRED
        'from': str,  # REQUIRED
    },
)


class BillingPlan(TypedDict, total=False):
    """
    One billing plan of a store listing's ``billing.plans`` — the
    Stripe-shaped pricing proposal that rides every deploy and goes live on
    store approval. Apps carry it in ``appManifest.billing``, pipelines in
    the ``store.billing`` block.
    """

    nickname: str  # Plan display name ("Starter", "Pro")
    amountCents: int | float  # Price in cents, as declared (the TypeScript `number`); whole cents in practice
    currency: str  # ISO currency code
    interval: str  # Billing interval ("month", "year", "one_time")
    metadata: dict[str, Any]  # Opaque plan metadata, preserved verbatim


class PipeStoreBilling(TypedDict):
    """The ``billing`` entry of a store block."""

    plans: list[BillingPlan]


class PipeStoreBlock(TypedDict, total=False):
    """
    The ``store`` block of a ``.pipe``: the pipeline's store listing. A
    pipeline carries one when it is deployed: the packer and the deploy door
    add the default block to a pipe that has none (a version stored by an
    earlier release can lack it). Mirrors an app's ``appManifest``
    listing fields; ``project_id``, ``name``, ``description`` and ``source``
    stay at the pipe's root and are never duplicated here. The engine never
    sees the block.
    """

    tagline: str  # One-line tagline for the store card
    categories: list[str]  # Store categories
    tags: list[str]  # Free tags
    icon: str  # Icon path, relative to the pipe file's directory
    readme: str  # README path (the store page), relative to the pipe file's directory
    links: dict[str, str]  # Links the listing shows, label -> URL
    mode: Literal['free', 'subscription', 'paywall']  # Monetization mode
    billing: PipeStoreBilling  # Pricing plans


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
    store: PipeStoreBlock  # The store listing; a pipe deployed without one gets the default block
    parameters: dict[str, str]  # Per-call params: public name -> 'nodeId.configKey'
    # The storage roots beyond its run's anchor this pipeline's nodes reach
    # through self.files ('@Development/kb', '=team/<tid>/kb', '@org/shared');
    # resolved through the run's owner when it starts (a root the owner
    # cannot reach refuses the start); refused on a @public publish
    roots: list[str]
    viewport: dict[str, Any]  # UI viewport settings for visual editors
    docRevision: int  # Editor document revision counter for change tracking
    isLocked: bool  # Whether the canvas is locked from editing
    snapToGrid: bool  # Whether node snapping to grid is enabled
    snapGridSize: list[int]  # Grid size for snapping [x, y]
    editorMode: str  # Active editor mode (e.g. 'design', 'status', 'flow')


#: How much of a request's flow the engine records and sends as FLOW events,
#: from nothing to every node's input and output: ``use()`` and ``submit()``
#: take it, and so does a DataPipe for its own transaction.
PipelineTraceLevel = Literal['none', 'metadata', 'summary', 'full']


class SUBMIT_RESULT(TypedDict, total=False):
    """
    What ``submit()`` returns: the pipe ``close`` body plus the stamps.

    The close body's own fields (``result_types``, ``objects`` ...) ride
    beside these. Stamps:
    """

    token: str  # The control id that answered: opaque, transient, valid for the life of the control; never persist it
    address: str  # The address that answered: developerId.pipelineId.source (the stable identity, beside the id)
    resolved: Literal['@spec', '@me', '@team', '@org', '@public']  # The rung that answered
    team: str  # On '@team': the answering team
    version: int  # The artifact version (absent on '@spec')
    engineKey: str  # The engine the request ran on (shape key, owner-qualified)
    converged: Literal['none', 'started']  # 'none': an existing control answered; 'started': this call created one
    ignored: List[str]  # Server-controlled arguments a name call passed (threads/args/env/ttl)
