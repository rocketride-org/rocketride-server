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
Event System for RocketRide DAP Communication.

This module defines the complete event system for Debug Adapter Protocol (DAP) communication,
providing intelligent event filtering, multi-client support, and network optimization for
distributed computational pipeline systems.

Event Architecture:
    The event system enables selective event subscription with multiple categories,
    allowing clients to receive only relevant events based on their role and needs.
    This reduces network traffic and improves system performance in multi-client
    distributed environments.

Event Types:
    EVENT_TYPE: Flag enum for event subscription categories (DEBUGGER, DETAIL, SUMMARY, etc.)
    EVENT_STATUS_UPDATE: Task status updates with processing statistics
    EVENT_TASK: Task lifecycle management (running, begin, end)

Subscription Model:
    Clients can subscribe to specific event types using bitwise flag combinations:
    - DEBUGGER: Debug protocol events and breakpoints
    - DETAIL: Real-time processing events requiring immediate attention
    - SUMMARY: Periodic consolidated status updates for dashboards
    - OUTPUT: Standard output and logging messages
    - FLOW: Pipeline execution flow and component tracking
    - TASK: Task lifecycle events (start, stop, state changes)
    - ALL: Comprehensive monitoring for administrative tools
    - NONE: Unsubscribe from all events

Network Optimization:
    Event filtering significantly reduces network bandwidth by:
    - Sending only subscribed event types to each client
    - Consolidating frequent updates into periodic summaries (SUMMARY vs DETAIL)
    - Eliminating redundant event delivery to uninterested clients
    - Supporting efficient multi-client scenarios with different monitoring needs

Usage:
    from rocketride.types import EVENT_TYPE, EVENT_STATUS_UPDATE, EVENT_TASK

    # Subscribe to specific event types
    async def on_event(event):
        if event['event'] == 'apaevt_status_update':
            status = event['body']
            print(f"Task status: {status['state']}")
        elif event['event'] == 'apaevt_task':
            action = event['body']['action']
            print(f"Task {action}")

    # Configure client with event subscription
    client = RocketRideClient(
        auth='your_api_key',
        onEvent=on_event
    )

    # Subscribe to monitoring events
    subscription = EVENT_TYPE.SUMMARY | EVENT_TYPE.TASK
    await client.subscribe(subscription)
"""

from enum import Flag
from typing import Literal, TypedDict, List, Union
from .task import TASK_STATUS
from .data import PIPELINE_RESULT


class EVENT_TYPE(Flag):
    """
    Event type enumeration for sophisticated client subscription and event routing.

    This enumeration defines event categories used for intelligent event filtering
    and routing in multi-client environments. It enables clients to subscribe
    to specific types of events based on their needs and capabilities, reducing
    network traffic and improving system performance.

    Event Categories:
    ----------------
    NONE: Unsubscribe from all events (cleanup and disconnection)
    ALL: Subscribe to all events regardless of category (comprehensive monitoring)
    DEBUGGER: Debug-specific events for debugging protocol communication
    DETAIL: Real-time processing events requiring immediate client attention
    SUMMARY: Periodic status summaries suitable for dashboard monitoring
    OUTPUT: Standard output and logging messages
    FLOW: Pipeline flow events - component execution tracking
    TASK: Task lifecycle events - start, stop, state changes

    Subscription Strategies:
    -----------------------
    NONE: Used during client disconnection to stop all event delivery
          and perform cleanup of monitoring subscriptions.

    ALL: Comprehensive monitoring for administrative clients that need
         complete visibility into task execution and debugging activities.

    DEBUGGER: Debug protocol events including breakpoint hits, variable
              changes, stack traces, and debugging session management.

    DETAIL: Real-time processing events including object processing updates,
            error/warning messages, metrics updates, and immediate status
            changes requiring client response or display updates.

    SUMMARY: Periodic status summaries sent at CONST_STATUS_UPDATE_FREQ
             intervals containing complete task status, suitable for
             monitoring dashboards and periodic client updates.

    OUTPUT: Standard output and logging messages from task execution.

    FLOW: Pipeline flow events tracking component execution, data flow
          between pipeline stages, and processing pipeline status.

    TASK: Task lifecycle events including task start, stop, pause, resume,
          and state changes for task management interfaces.

    Network Optimization:
    --------------------
    Event filtering reduces network traffic by sending only relevant events
    to interested clients. SUMMARY subscriptions receive consolidated status
    updates rather than individual processing events, significantly reducing
    bandwidth usage for monitoring applications.

    Multi-Client Support:
    --------------------
    Different clients can subscribe to different event types simultaneously:
    - Debugging clients: DEBUGGER + DETAIL for comprehensive debugging
    - Monitoring dashboards: SUMMARY for efficient status tracking
    - Administrative tools: ALL for complete system visibility
    - Log viewers: OUTPUT for message monitoring
    - Pipeline managers: FLOW + TASK for execution tracking

    Usage Examples:
    --------------
    # Subscribe to debugging and detail events
    subscription = EVENT_TYPE.DEBUGGER | EVENT_TYPE.DETAIL

    # Check if client wants specific events
    if client_subscription & EVENT_TYPE.SUMMARY:
        send_summary_update(client, task_status)

    # Check for multiple event types
    if client_subscription & (EVENT_TYPE.FLOW | EVENT_TYPE.TASK):
        send_pipeline_event(client, event)
    """

    NONE = 0  # No events - unsubscribe from all event types
    DEBUGGER = 1 << 0  # Debug protocol events - DAP and debugging-specific events like breakpoints, stack traces
    DETAIL = 1 << 1  # Real-time processing events - immediate updates for live monitoring
    SUMMARY = 1 << 2  # Periodic status summaries - dashboard monitoring with reduced frequency
    OUTPUT = 1 << 3  # Standard output and logging messages from task execution
    FLOW = 1 << 4  # Pipeline flow events - component execution tracking and data flow visualization
    TASK = 1 << 5  # Task lifecycle events - start, stop, state changes, and task management
    SSE = 1 << 6  # Real-time node-to-UI messages emitted via monitorSSE() during pipeline execution
    DASHBOARD = 1 << 7  # Server-level events - connection added/removed, for admin dashboards

    # Convenience combination - ALL events except NONE for comprehensive monitoring
    ALL = DEBUGGER | DETAIL | SUMMARY | OUTPUT | FLOW | TASK | SSE | DASHBOARD


class EVENT_STATUS(TypedDict, total=False):
    """
    DAP event for task status updates with comprehensive processing statistics.

    This event is sent whenever a task's status changes, providing real-time
    visibility into task execution progress, error conditions, and performance
    metrics. It contains the complete TASK_STATUS structure with all processing
    statistics, error tracking, and operational state information.

    Event Triggers:
    - Task state changes (NONE → STARTING → RUNNING → COMPLETED, etc.)
    - Processing progress updates (item counts, byte counts, rates)
    - Error and warning conditions
    - Service health status changes
    - Pipeline component execution flow changes

    Client Subscriptions:
    - DETAIL: Real-time updates for immediate display
    - SUMMARY: Periodic consolidated updates for dashboards
    - ALL: Comprehensive monitoring for administrative tools

    Usage Example:
    -------------
    def handle_status_update(event: EVENT_STATUS_UPDATE) -> None:
        status = event["body"]
        print(f"Task {status['name']} is {'running' if status['state'] == 3 else 'idle'}")
        print(f"Progress: {status['completedCount']}/{status['totalCount']} items")
    """

    type: Literal['event']  # REQUIRED - DAP message type, always "event" for events
    event: Literal['apaevt_status_update']  # REQUIRED - Event type identifier for status update events
    body: TASK_STATUS  # REQUIRED - Complete task status information with processing statistics and metrics


class TASK_RUNNING_ENTRY(TypedDict):
    """Task info entry in the 'running' action payload."""

    id: str  # Unique task identifier
    name: str  # Display name of the task (e.g. 'Parser1.Chat')
    projectId: str  # Project identifier
    source: str  # Source component entry point


class TASK_EVENT_RUNNING(TypedDict):
    """Snapshot of all active tasks, sent on initial subscription."""

    action: Literal['running']
    tasks: List[TASK_RUNNING_ENTRY]


class TASK_EVENT_BEGIN(TypedDict):
    """A task has started execution."""

    action: Literal['begin']
    name: str  # Display name of the task
    projectId: str  # Project identifier
    source: str  # Source component identifier


class TASK_EVENT_END(TypedDict):
    """A task has completed or been terminated."""

    action: Literal['end']
    name: str  # Display name of the task
    projectId: str  # Project identifier
    source: str  # Source component identifier


class TASK_EVENT_RESTART(TypedDict):
    """A task has been restarted."""

    action: Literal['restart']
    name: str  # Display name of the task
    projectId: str  # Project identifier
    source: str  # Source component identifier


TASK_EVENT = Union[TASK_EVENT_RUNNING, TASK_EVENT_BEGIN, TASK_EVENT_END, TASK_EVENT_RESTART]


class EVENT_TASK(TypedDict, total=False):
    """Full DAP event for task lifecycle."""

    type: Literal['event']
    event: Literal['apaevt_task']
    body: TASK_EVENT


class TASK_EVENT_FLOW(TypedDict, total=False):
    """
    Pipeline flow event body — component execution and data flow visualization.

    Sent during pipeline execution to track data flowing through components.
    Each event represents a pipeline operation (begin, enter, leave, end) on
    a specific pipe within the pipeline.
    """

    id: int  # REQUIRED - Pipe index within the pipeline
    op: str  # REQUIRED - Operation type: 'begin', 'enter', 'leave', 'end'
    pipes: List[str]  # REQUIRED - Component names in the current pipe's execution path
    trace: dict  # REQUIRED - Trace data: lane, input/output data, result, error
    result: PIPELINE_RESULT  # Present when op == 'end' and trace level >= summary
    project_id: str  # REQUIRED - Project identifier
    source: str  # REQUIRED - Source component identifier (e.g. "chat_1")


class EVENT_FLOW(TypedDict, total=False):
    """Full DAP event for pipeline flow tracking."""

    type: Literal['event']
    event: Literal['apaevt_flow']
    body: TASK_EVENT_FLOW
