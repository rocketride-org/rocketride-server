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
from typing import Any


class EngineState(Enum):
    """
    The lifecycle state of a TaskEngine (the process), owned by the engine (plan 7.2).

    One variable answers every "is it safe to attach / stop / roll back to this
    engine" question that was spread over flags before:

    - ``NEW``: built, not yet started.
    - ``STARTING``: launched; the pipeline has not reported its service up.
    - ``RUNNING``: confirmed running; takes requests and holds.
    - ``STOPPING``: a stop was requested; takes no new holds.
    - ``STOPPED``: the process is gone after it had run (a clean exit, the
      inactivity timer, an operator, a crash); a control's next request may
      start the key again.
    - ``FAILED``: the process ended before it ever confirmed running; a start
      that is not retried (``engine_start_failed``).
    """

    NEW = 'new'
    STARTING = 'starting'
    RUNNING = 'running'
    STOPPING = 'stopping'
    STOPPED = 'stopped'
    FAILED = 'failed'


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


class TaskError(RuntimeError):
    """
    A task lookup or readiness failure that carries a machine-readable code.

    ``DAPBase.build_exception`` copies ``code`` onto the DAP error packet next to
    the human-readable ``message``, so a client classifies the failure on the
    code instead of matching the English text. Subclasses ``RuntimeError`` so
    existing ``except RuntimeError`` handling is unchanged.

    Codes:
    - TASK_NOT_REGISTERED: the address or project/source names no live task
      on any rung the caller may reach — never started, terminated,
      replaced, or the engine restarted and rebuilt its in-memory registry
    - TASK_COMPLETED: the task finished before the request could be served
    - TASK_STOPPED: the task was stopped or cancelled before the request
    - TASK_INVALID_ARGUMENT: a request value breaks the grammar — an address
      that is not 2 or 3 dot-free segments, a component or project id with
      a character outside ``[A-Za-z0-9_-]``, an identity carrying ``/``,
      whitespace or ``~``, or a client trying to name the registry key
    - TASK_SOURCE_REQUIRED: a two-segment address names a pipe with several
      live sources and no default; ``sources`` lists them
    - TASK_SPEC_CHANGED: a spec call with ``onChange='error'`` met a live
      presence running other content; ``currentHash`` and ``newHash``
    - TASK_TIMEOUT: a ``submit()`` request exceeded the caller's
      ``timeout`` (open to close); ``address`` and ``converged``
    - TASK_PAYLOAD_TOO_LARGE: inline ``submit()`` data over
      ``CONST_SUBMIT_INLINE_MAX``; ``limit``
    - TASK_ENGINE_UNAVAILABLE: the engine under the caller's hold was stopped
      by an operator; ``engineKey`` and ``reason`` say which and why. Told
      once per control: the next call re-resolves
    - TASK_ENGINE_START_FAILED: an engine never confirmed running (plan 3.8,
      7.2): no event from the subprocess for ``CONST_MAX_READY_TIME``, a
      spec that cannot be keyed; ``engineKey``
    - TASK_PARAM_REJECTED: per-call ``params`` named a public name the
      pipeline's ``parameters`` map does not expose (plan 5.4 item 5);
      ``errors`` lists ``{name, reason}`` per rejected key

    Extra keyword fields (``field``, ``address``, ``sources``, …) become
    attributes so a caller can classify on more than the code.
    """

    NOT_REGISTERED = 'TASK_NOT_REGISTERED'
    COMPLETED = 'TASK_COMPLETED'
    STOPPED = 'TASK_STOPPED'
    INVALID_ARGUMENT = 'TASK_INVALID_ARGUMENT'
    SOURCE_REQUIRED = 'TASK_SOURCE_REQUIRED'
    ENGINE_UNAVAILABLE = 'TASK_ENGINE_UNAVAILABLE'
    SPEC_CHANGED = 'TASK_SPEC_CHANGED'
    TIMEOUT = 'TASK_TIMEOUT'
    PAYLOAD_TOO_LARGE = 'TASK_PAYLOAD_TOO_LARGE'
    ENGINE_START_FAILED = 'TASK_ENGINE_START_FAILED'
    PARAM_REJECTED = 'TASK_PARAM_REJECTED'

    def __init__(self, code: str, message: str, **fields: Any):
        super().__init__(message)
        self.code = code
        for name, value in fields.items():
            setattr(self, name, value)
