"""
Task Management Types: Comprehensive Status Tracking and Event Management System.

This module defines the complete type system for sophisticated task lifecycle management,
real-time status monitoring, and event-driven communication in distributed computational
pipeline systems. It provides structured data models for tracking complex task execution
states, processing statistics, error management, and pipeline flow visualization.

Core Type Categories:
--------------------
- Launch Types: Task creation and execution modes with different debugging capabilities
- Event Types: Sophisticated event filtering and routing for multi-client monitoring
- Task States: Complete lifecycle state management from initialization to cleanup
- Status Models: Comprehensive task status tracking with real-time metrics
- Flow Models: Pipeline component execution tracking and visualization

Key Features:
-------------
- Multi-client event filtering with subscription-based routing
- Comprehensive processing statistics with rates and counters
- Error and warning management with buffer limits and history
- Pipeline flow tracking with component-level execution visibility
- Resource usage monitoring with performance metrics
- Service health tracking with up/down state management
- Exit code tracking with detailed termination information

Integration Points:
------------------
- TaskServer: Central orchestration using these types for state management
- Task: Individual task instances maintaining status using these models
- Monitoring Clients: Event subscription using EVENT_TYPE filtering
- Debug Interfaces: State transitions and status updates
- Pipeline Components: Flow tracking and component execution monitoring

Data Models:
-----------
- TASK_STATUS: Comprehensive task state with processing statistics
- TASK_STATUS_FLOW: Pipeline component execution tracking and visualization
- Enumerations: Type-safe constants for states, events, and launch modes

Type Safety:
-----------
All enumerations provide type-safe constants preventing invalid state transitions
and ensuring consistent event handling across the distributed system.
"""

from enum import Enum


class LAUNCH_TYPE(Enum):
    """
    Task launch type enumeration defining execution modes and debugging capabilities.

    This enumeration specifies how tasks are created and executed, determining
    the available debugging interfaces, client attachment behavior, and resource
    allocation strategies. Each launch type provides different capabilities
    optimized for specific use cases.

    Launch Types:
    - LAUNCH: Interactive debugging-enabled task creation
    - ATTACH: Connection to existing running task instances
    - EXECUTE: Batch processing without debugging overhead

    Usage Scenarios:
    ---------------
    LAUNCH: Development and debugging scenarios where interactive debugging
            capabilities are required. Provides full DAP protocol support,
            breakpoint management, variable inspection, and step debugging.

    ATTACH: Multi-client collaborative debugging where multiple clients
            need to connect to the same running task instance. Enables
            shared debugging sessions and monitoring.

    EXECUTE: Production batch processing where debugging overhead should
             be minimized. Optimized for performance with minimal debugging
             interfaces but full monitoring capabilities.

    Resource Implications:
    ---------------------
    - LAUNCH: Full resource allocation including debug ports and interfaces
    - ATTACH: Minimal resource overhead, reuses existing task resources
    - EXECUTE: Optimized resource usage with reduced debugging infrastructure

    Client Behavior:
    ---------------
    - LAUNCH: Client becomes primary debugger with full control capabilities
    - ATTACH: Client shares debugging access with other attached clients
    - EXECUTE: Client receives monitoring events but limited debugging access
    """

    LAUNCH = 'launch'  # Create new task with full debugging capabilities
    ATTACH = 'attach'  # Connect to existing task instance for debugging
    EXECUTE = 'execute'  # Create new task optimized for batch processing
