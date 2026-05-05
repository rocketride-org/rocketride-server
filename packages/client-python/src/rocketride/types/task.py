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
Task Status and Lifecycle Management Types.

This module defines the complete type system for task lifecycle management, real-time status
monitoring, and event-driven communication in RocketRide's distributed pipeline processing system.
These types provide structured data models for tracking complex task execution states, processing
statistics, error management, and pipeline flow visualization.

Types Defined:
    TASK_STATE: Enumeration of task lifecycle states
    TASK_STATUS_FLOW: Pipeline component execution flow tracking
    TASK_STATUS: Comprehensive task status with processing statistics

Task Lifecycle:
    Tasks progress through well-defined states from initialization through completion:

    NONE → STARTING → INITIALIZING → RUNNING → STOPPING → COMPLETED (success)
                                              → STOPPING → CANCELLED (termination)

    Each state transition triggers events to subscribed clients, enabling real-time
    monitoring and responsive user interfaces.

Status Tracking:
    The TASK_STATUS model provides comprehensive execution metrics including:
    - Processing counts and byte statistics
    - Real-time processing rates
    - Error and warning history
    - Resource utilization metrics
    - Pipeline component execution flow
    - Service health status

Flow Visualization:
    The TASK_STATUS_FLOW model enables real-time visualization of pipeline execution,
    showing which components are actively executing in each pipeline instance. This
    supports debugging, performance analysis, and execution monitoring.

Usage:
    from rocketride.types import TASK_STATE, TASK_STATUS

    # Check task state
    async def monitor_task(client, token):
        status = await client.status(token)

        if status['state'] == TASK_STATE.RUNNING.value:
            print(f"Processing: {status['completedCount']}/{status['totalCount']}")
            print(f"Rate: {status['rateCount']} items/sec")
        elif status['state'] == TASK_STATE.COMPLETED.value:
            print(f"Completed with exit code: {status['exitCode']}")

        # Check for errors
        if status['errors']:
            for error in status['errors']:
                print(f"Error: {error}")
"""

from typing import List, Dict, Union
from enum import Enum
from pydantic import BaseModel, Field


class TASK_STATE(Enum):
    """
    Task lifecycle state enumeration for comprehensive state management.

    This enumeration defines all possible states in the task execution lifecycle,
    providing clear state transitions and enabling proper resource management,
    error handling, and client notification. Each state represents a distinct
    phase with specific characteristics and available operations.

    Lifecycle Phases:
    ----------------
    NONE: Initial state before any resources are allocated or configuration
          is processed. Tasks in this state can be safely discarded without
          cleanup operations.

    STARTING: Resource allocation and initial setup phase. Ports are allocated,
              temporary files created, and subprocess preparation occurs.

    INITIALIZING: Subprocess has been created and is performing pipeline
                  initialization. Service interfaces are being established.

    RUNNING: Task is operational and processing requests. All interfaces
             are available and the pipeline is actively executing.

    STOPPING: Graceful shutdown initiated. Subprocess is being terminated
              and resources are being cleaned up.

    COMPLETED: Task finished successfully. All resources cleaned up and
               final status available for client queries.

    CANCELLED: Task was terminated before completion. Resources cleaned up
               and termination reason available in status.

    State Transitions:
    -----------------
    Normal execution flow:
    NONE → STARTING → INITIALIZING → RUNNING → STOPPING → COMPLETED

    Cancellation flow:
    Any state → STOPPING → CANCELLED

    Error handling:
    Any state → STOPPING → COMPLETED (with error exit code)

    Resource Management:
    -------------------
    - NONE/COMPLETED/CANCELLED: No active resources requiring cleanup
    - STARTING/INITIALIZING/RUNNING: Active resources requiring cleanup
    - STOPPING: Cleanup in progress, resources being deallocated

    Client Operations:
    -----------------
    - NONE: Configuration and launch operations available
    - STARTING/INITIALIZING: Status monitoring available
    - RUNNING: Full debugging and data processing operations available
    - STOPPING: Limited status monitoring, operations being rejected
    - COMPLETED/CANCELLED: Status queries only, task cleanup may be initiated

    Wait Operations:
    ---------------
    Clients can wait for specific state transitions using wait_for_running()
    and similar methods. State transitions trigger event notifications to
    all subscribed monitoring clients.
    """

    NONE = 0  # Initial state - no resources allocated
    STARTING = 1  # Resource allocation and subprocess preparation
    INITIALIZING = 2  # Subprocess initialization and service startup
    RUNNING = 3  # Operational state - processing requests
    STOPPING = 4  # Graceful shutdown and resource cleanup in progress
    COMPLETED = 5  # Successful completion - resources cleaned up
    CANCELLED = 6  # Terminated before completion - resources cleaned up


class TASK_TOKENS(BaseModel):
    """
    Task token usage tracking (user-facing billing).

    Behavior:
        - Values are CUMULATIVE from when monitoring starts
        - Updated in real-time every 250ms as metrics are sampled
        - Preserved when monitoring stops (frozen at final values)
        - RESET to 0.0 when start_monitoring() is called for a new session

    """

    cpu_utilization: float = Field(
        default=0.0, description='Cumulative CPU utilization tokens charged since monitoring started'
    )
    cpu_memory: float = Field(default=0.0, description='Cumulative CPU memory tokens charged since monitoring started')
    gpu_memory: float = Field(default=0.0, description='Cumulative GPU memory tokens charged since monitoring started')
    total: float = Field(
        default=0.0,
        description='Total cumulative tokens charged (cpu_utilization + cpu_memory + gpu_memory) since monitoring started',
    )


class TASK_METRICS(BaseModel):
    """
    Task resource utilization metrics.

    Per-process metrics for monitoring CPU, memory, and GPU usage during task execution.
    All metrics are process-specific (not system-wide) to ensure accurate billing and monitoring.
    CPU percentages are normalized to 0-100% range across all platforms for consistent
    monitoring experience regardless of hardware configuration.

    Metrics Categories:
    ------------------
    - Current Snapshot: Real-time resource usage values
    - Peak Values: Maximum resource usage observed during task lifetime
    - Average Values: Mean resource usage calculated over task lifetime

    Normalization:
    -------------
    CPU percentages are normalized by dividing by the number of CPU cores, ensuring
    values always fall within 0-100% range regardless of multi-core system configuration.

    Units:
    -----
    - CPU Utilization: Percentage (0-100%, normalized per-process)
    - CPU Memory: Megabytes (MB, process RAM usage)
    - GPU Memory: Megabytes (MB, process VRAM usage)
    """

    # Current snapshot
    cpu_percent: float = Field(
        default=0.0, description='Current CPU utilization percentage (normalized 0-100%, per-process)'
    )
    cpu_memory_mb: float = Field(default=0.0, description='Current CPU memory (RAM) usage in megabytes (per-process)')
    gpu_memory_mb: float = Field(default=0.0, description='Current GPU memory (VRAM) usage in megabytes (per-process)')

    # Peak values
    peak_cpu_percent: float = Field(default=0.0, description='Peak CPU utilization percentage during task execution')
    peak_cpu_memory_mb: float = Field(
        default=0.0, description='Peak CPU memory usage in megabytes during task execution'
    )
    peak_gpu_memory_mb: float = Field(
        default=0.0, description='Peak GPU memory usage in megabytes during task execution'
    )

    # Average values
    avg_cpu_percent: float = Field(default=0.0, description='Average CPU utilization percentage over task lifetime')
    avg_cpu_memory_mb: float = Field(
        default=0.0, description='Average CPU memory usage in megabytes over task lifetime'
    )
    avg_gpu_memory_mb: float = Field(
        default=0.0, description='Average GPU memory usage in megabytes over task lifetime'
    )


class TASK_STATUS_FLOW(BaseModel):
    """
    Pipeline component execution flow tracking and visualization model.

    This model provides detailed tracking of pipeline component execution flow,
    enabling real-time visualization of which components are currently executing
    in each pipeline instance. It supports complex pipeline architectures with
    multiple concurrent execution paths and nested component hierarchies.

    Flow Tracking Features:
    ----------------------
    - Multi-pipeline execution tracking with per-instance component stacks
    - Real-time component entry/exit monitoring for performance analysis
    - Visual pipeline flow representation for debugging and monitoring
    - Component execution depth tracking for nested pipeline architectures
    - Concurrent execution visibility across multiple pipeline instances

    Data Structure:
    --------------
    totalPipes: Total number of concurrent pipeline execution instances
    byPipe: Dictionary mapping pipeline instance IDs to component execution stacks

    Component Stack Behavior:
    ------------------------
    Each pipeline instance maintains a stack of currently executing components:
    - Component entry pushes component name onto the stack
    - Component exit pops component name from the stack
    - Stack depth indicates nesting level of component execution
    - Empty stack indicates pipeline instance is idle or completed

    Visualization Applications:
    --------------------------
    - Real-time pipeline execution diagrams showing active components
    - Performance analysis identifying bottlenecks and execution patterns
    - Debugging support for component-level execution tracing
    - Monitoring dashboards displaying pipeline health and activity

    Concurrent Execution Support:
    ----------------------------
    Multiple pipeline instances can execute simultaneously, each maintaining
    independent component execution stacks. This enables complex parallel
    processing scenarios with full visibility into each execution path.

    Example Flow Tracking:
    ---------------------
    Pipeline 0: ['source', 'transform', 'filter'] - Currently in filter component
    Pipeline 1: ['source', 'transform']           - Currently in transform component
    Pipeline 2: []                                - Idle or completed
    """

    totalPipes: int = Field(default=0, description='Total number of concurrent pipeline execution instances')

    byPipe: Dict[int, List[str]] = Field(
        default_factory=dict, description='Component execution stacks by pipeline instance ID'
    )


class TASK_STATUS(BaseModel):
    """
    Comprehensive task status model with real-time processing statistics and metrics.

    This model provides complete task execution status including processing statistics,
    error tracking, performance metrics, resource usage, and operational state.
    It serves as the central status repository for task monitoring, client updates,
    and administrative dashboards.

    Status Categories:
    -----------------
    - Job Information: Basic task identification and lifecycle status
    - Processing Statistics: Counts, sizes, rates, and completion metrics
    - Error Management: Error and warning tracking with message history
    - Resource Monitoring: Service health and operational state
    - Performance Metrics: Processing rates and resource utilization
    - Pipeline Tracking: Component execution flow and pipeline visualization

    Real-Time Updates:
    -----------------
    Status is updated in real-time as the task processes data and progresses
    through its lifecycle. Updates are broadcast to subscribed clients based
    on their EVENT_TYPE subscriptions, enabling responsive monitoring and
    debugging interfaces.

    Buffer Management:
    -----------------
    Error and warning lists maintain recent message history with automatic
    buffer limits to prevent memory growth in long-running tasks. Trace
    buffers preserve debugging information while controlling resource usage.

    Metrics Integration:
    -------------------
    Processing statistics and performance metrics are continuously updated
    to provide real-time visibility into task performance, throughput,
    and resource utilization patterns.

    Client Integration:
    ------------------
    Status information is serialized and broadcast to monitoring clients,
    debugging interfaces, and administrative dashboards. Different client
    types receive filtered status updates based on their subscription preferences.
    """

    # Job Information and Lifecycle Status
    name: str = Field(default='', description='Human-readable task name derived from pipeline source component')

    project_id: str = Field(default='', description='Unique identifier for the project associated with the task')

    source: str = Field(default='', description='Source component to execute')

    completed: bool = Field(default=False, description='Task completion flag - true when task has finished execution')

    state: int = Field(
        default=TASK_STATE.NONE.value, description='Current task lifecycle state from TASK_STATE enumeration'
    )

    startTime: float = Field(default=0.0, description='Task start timestamp (Unix time) for duration calculation')

    endTime: float = Field(default=0.0, description='Task completion timestamp (Unix time) for duration calculation')

    debuggerAttached: bool = Field(default=False, description='Debugger attachment status')

    # Current Status and Operational Messages
    status: str = Field(default='', description='Current status message describing task activity and progress')

    # Error and Warning Management with History
    warnings: List[str] = Field(
        default_factory=list, description='Warning message history (limited to 50 recent entries)'
    )

    errors: List[str] = Field(default_factory=list, description='Error message history (limited to 50 recent entries)')

    # Current Processing Context
    currentObject: str = Field(default='', description='Name/identifier of the item currently being processed')

    currentSize: int = Field(default=0, description='Size in bytes of the item currently being processed')

    # Status Notes and Contextual Information
    notes: List[Union[str, dict]] = Field(
        default_factory=list, description='Contextual notes and information for status display'
    )

    # Comprehensive Processing Statistics
    totalSize: int = Field(default=0, description='Total size in bytes of all items to be processed')

    totalCount: int = Field(default=0, description='Total count of all items to be processed')

    completedSize: int = Field(default=0, description='Total size in bytes of successfully processed items')

    completedCount: int = Field(default=0, description='Total count of successfully processed items')

    failedSize: int = Field(default=0, description='Total size in bytes of items that failed processing')

    failedCount: int = Field(default=0, description='Total count of items that failed processing')

    wordsSize: int = Field(default=0, description='Total size in bytes of extracted/processed text content')

    wordsCount: int = Field(default=0, description='Total count of words extracted/processed from content')

    # Real-Time Processing Rates
    rateSize: int = Field(default=0, description='Current processing rate in bytes per second (instantaneous)')

    rateCount: int = Field(default=0, description='Current processing rate in items per second (instantaneous)')

    # Service Health and Operational State
    serviceUp: bool = Field(
        default=False, description='Service operational status - true when ready to process requests'
    )

    # Task Termination Information
    exitCode: int = Field(default=0, description='Process exit code - 0 for success, non-zero for errors')

    exitMessage: str = Field(default='', description='Exit message providing details about task termination')

    # Pipeline Component Execution Flow Tracking
    pipeflow: TASK_STATUS_FLOW = Field(
        default_factory=TASK_STATUS_FLOW, description='Pipeline component execution flow and visualization data'
    )

    # Resource Utilization Metrics (user-facing, normalized)
    metrics: TASK_METRICS = Field(
        default_factory=TASK_METRICS,
        description='Real-time resource utilization metrics (CPU normalized to 0-100%, memory in MB, GPU memory in MB)',
    )

    # Token Usage (user-facing billing - cumulative tokens from task start)
    tokens: TASK_TOKENS = Field(
        default_factory=TASK_TOKENS, description='Cumulative token usage for CPU, memory, GPU (100 tokens = $1.00)'
    )
