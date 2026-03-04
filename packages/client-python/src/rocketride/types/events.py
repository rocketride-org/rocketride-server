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
from typing import Literal, TypedDict, List
from .task import TASK_STATUS


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

    # Convenience combination - ALL events except NONE for comprehensive monitoring
    ALL = DEBUGGER | DETAIL | SUMMARY | OUTPUT | FLOW | TASK


class EVENT_STATUS_UPDATE(TypedDict, total=False):
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


class _EVENT_TASK_INFO(TypedDict):
    """
    Information about a currently running task.

    This structure provides essential task identification and context information
    for task lifecycle management and client-side tracking. Used within the
    EVENT_TASK 'running' action to list active tasks.
    """

    id: str  # Unique task identifier for tracking and management
    projectId: str  # Project identifier for organization and permissions
    source: str  # Source component that serves as pipeline entry point


class _EVENT_TASK_BODY(TypedDict, total=False):
    """
    Body structure for apaevt_task events with discriminated union behavior.

    This structure supports three distinct task lifecycle scenarios:
    - 'running': Lists all currently running tasks for the client's API key
    - 'begin': Notifies that a new task has started execution
    - 'end': Notifies that a task has completed or terminated

    Field Usage by Action:
    - action='running': tasks field is required, projectId/source are not used
    - action='begin'/'end': projectId/source are required, tasks is not used

    Note: Python's TypedDict with total=False doesn't provide the same strict
    discriminated union behavior as TypeScript, so field validation should be
    handled in application logic.
    """

    action: Literal['running', 'begin', 'end']  # REQUIRED - Action identifier for task lifecycle events

    # For 'running' action - provides current task inventory
    tasks: List[_EVENT_TASK_INFO]  # Array of currently running tasks belonging to client's API key

    # For 'begin' and 'end' actions - task identification and context
    projectId: str  # Project identifier for organization and permissions tracking
    source: str  # Source component identifier that serves as pipeline entry point


class EVENT_TASK(TypedDict, total=False):
    """
    DAP event for task lifecycle management with action-based event routing.

    This event handles three distinct task lifecycle scenarios, providing
    comprehensive task management capabilities for client applications.
    While Python doesn't support strict discriminated unions like TypeScript,
    the action field determines which other fields are relevant.

    Action Types and Usage:
    - 'running': Sent when client first subscribes to EVENT_TYPE.TASK,
                 provides snapshot of all active tasks for immediate state sync
    - 'begin': Sent when a task starts execution, includes task identification
    - 'end': Sent when a task completes or terminates, includes task identification

    Event Flow:
    1. Client subscribes to EVENT_TYPE.TASK
    2. Server immediately sends 'running' action with current task list
    3. As tasks start/stop, server sends 'begin'/'end' actions

    Network Optimization:
    - 'running' action sent only once per subscription to provide initial state
    - 'begin'/'end' actions sent as lightweight notifications
    - Only tasks belonging to client's API key are included

    Field Validation:
    Since Python's TypedDict doesn't enforce discriminated union behavior,
    application code should validate field combinations based on action:
    - action='running': expect 'tasks' field, ignore 'id'/'projectId'/'source'
    - action='begin'/'end': expect 'id' and body 'projectId'/'source', ignore 'tasks'

    Usage Example:
    -------------
    def handle_task_event(event: EVENT_TASK) -> None:
        action = event["body"]["action"]

        if action == "running":
            # Handle current task list
            tasks = event["body"].get("tasks", [])
            print(f"Found {len(tasks)} running tasks")
            for task in tasks:
                print(f"Task {task['id']} in project {task['projectId']}")

        elif action in ["begin", "end"]:
            # Handle task lifecycle notification
            task_id = event.get("id")
            project_id = event["body"].get("projectId")
            source = event["body"].get("source")
            print(f"Task {task_id} has {action}")
            print(f"Project: {project_id}, Source: {source}")
    """

    type: Literal['event']  # REQUIRED - DAP message type, always "event" for events
    event: Literal['apaevt_task']  # REQUIRED - Event type identifier for task lifecycle events
    body: _EVENT_TASK_BODY  # REQUIRED - Event body with action-specific data structure
    id: str  # Task identifier for lifecycle tracking (required for 'begin'/'end' actions, unused for 'running')
