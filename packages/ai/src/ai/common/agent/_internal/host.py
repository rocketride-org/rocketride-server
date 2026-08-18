"""
Framework-facing host services for agent framework drivers.

Wraps the engine control-plane invoke seam into a small interface:
  - host.llm.invoke(...)
  - host.tools.query/validate/invoke(...)
  - host.memory.put/get/list/clear(...)

Also defines `AgentContext` — the per-call run scaffolding object that
threads through `_run`, `call_llm`, `call_tool`, and `sendSSE`.  See the
plan in plans/elegant-cooking-finch.md for the architectural rationale.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ai.common.utils import safe_str
from rocketlib import ToolDescriptor
from rocketlib.types import IInvokeOp, IInvokeTool, IInvokeMemory, IInvokeGuard


def _check_guard(invoker, guard_nodes: List[str], mode: str, value: Any, *, label: str) -> None:
    """Run every guard node attached to this agent against a control-plane call.

    Shared by ``Tools.invoke`` (guarding tool calls) and ``Memory.put``/``get``/
    ``list`` (guarding persistent-memory reads and writes) — any channel that
    lets an agent move content in or out through the control plane.

    ``mode='output'`` checks content on its way out (agent-generated args
    being sent somewhere, or a value about to be written to memory) —
    PII/content-safety/hallucination checks. ``mode='input'`` checks content
    coming back in (a tool's result, or a value read back from memory) — the
    indirect-prompt-injection-into-tool-use case. This is inverted from what
    the mode names suggest at first glance because it mirrors the *direction
    of travel* relative to the agent, not the channel.

    Raises:
        ValueError: If any attached guard's `policy_mode` blocks this text,
            or if a guard node responds without a recognized `action` — a
            malformed or misconfigured guard fails closed rather than
            silently disabling the check. The exception surfaces to the
            calling framework driver as a tool/memory error, so the call
            never runs (pre-check) or its result never reaches the agent
            (post-check).
    """
    if not guard_nodes:
        return

    text = safe_str(value)
    if not text.strip():
        return

    for guard_node in guard_nodes:
        param = IInvokeGuard.Check(mode=mode, text=text)
        invoker.instance.invoke(param, component_id=guard_node)

        # A guard's result must be a mapping to be trusted at all; a
        # malformed shape (list/string/None/anything else) falls through to
        # the "no recognized action" fail-closed branch below rather than
        # crashing on .get() with an AttributeError.
        raw_result = getattr(param, 'result', None)
        result = raw_result if isinstance(raw_result, dict) else {}
        action = result.get('action')

        if action == 'block':
            raw_violations = result.get('violations')
            violations_list = raw_violations if isinstance(raw_violations, list) else []
            violations = ', '.join(v.get('rule', '?') if isinstance(v, dict) else str(v) for v in violations_list)
            raise ValueError(f'Guardrails blocked {label} ({mode}): {violations}')
        if action not in ('pass', 'warn', 'log'):
            raise ValueError(
                f'Guardrails blocked {label} ({mode}): guard {guard_node!r} returned no recognized action ({action!r})'
            )


class AgentHostServices:
    class LLM:
        """LLM host interface backed by IInvokeLLM operations."""

        def __init__(self, invoker):
            """Create an LLM host service wrapper bound to an engine invoker."""
            node = invoker.instance.getControllerNodeIds('llm')

            # There needs to be exactly 1 llm node
            if len(node) != 1:
                raise ValueError('You must have 1, and only 1 llm node connected to your agent')

            # Save it
            self._invoker = invoker
            self._llm = node[0]

        def invoke(self, param: IInvokeOp) -> Any:
            """
            Invoke the host LLM control-plane operation.

            Args:
                param: An IInvokeLLM operation (e.g. IInvokeLLM.Ask(question=q)).

            Returns:
                The engine-native response object.
            """
            return self._invoker.instance.invoke(param, component_id=self._llm)

    class Tools:
        """Tool host interface backed by IInvokeTool operations."""

        # NOTE: Do NOT declare _tool_nodes/_tool_list as class attributes.
        # They are per-instance state, fully initialized in __init__.  A
        # class-level mutable default would be shared across every Tools
        # instance in the process and silently leak tool descriptors between
        # concurrent agent runs.

        def __init__(self, invoker, guard_nodes: List[str]):
            """Create a Tools host service wrapper bound to an engine invoker.

            Discovers all tools on every connected tool node once at
            construction.  Drivers read the prepared catalog as
            ``self.list`` (a flat ``List[ToolDescriptor]``).

            Args:
                guard_nodes: Guard node ids attached to this agent, resolved
                    once by the caller (``AgentHostServices.__init__``) and
                    shared with ``Memory`` rather than each channel doing
                    its own ``getControllerNodeIds('guard')`` lookup.
            """
            self._invoker = invoker
            self._tool_list: Dict[str, Any] = {}
            self._tool_nodes: List[str] = self._invoker.instance.getControllerNodeIds('tool')
            self._guard_nodes = guard_nodes

            # For every tool node
            for tool_node in self._tool_nodes:
                # Get this nodes tool list
                param = IInvokeTool.Query()
                try:
                    self._invoker.instance.invoke(param, component_id=tool_node)
                except Exception:
                    # We expect this to throw because no node will
                    # return success — but param.tools should be populated with the tool descriptors from this node
                    pass

                # Add the tools, namespaced by node id so that two nodes
                # exposing the same tool name (e.g. two postgres instances)
                # never collide.
                for tool in param.tools:
                    # Get the actual tool name id
                    tool_id = tool.get('name')

                    # Create a unique identifier for it
                    namespaced = f'{tool_node}.{tool_id}'

                    # Build a descriptor for the tool, namespaced by node id
                    descriptor = {**tool, 'name': namespaced}

                    # And save it to the tool list
                    self._tool_list[namespaced] = {
                        'node_id': tool_node,
                        'tool_id': tool_id,
                        'tool': descriptor,
                    }

            # Prepared flat descriptor list, ready for direct reference
            # via `context.tools.list` from any driver.
            self.list: List[ToolDescriptor] = [entry['tool'] for entry in self._tool_list.values()]

        def get(self, tool_name: str) -> Any:
            """
            Get the full tool catalog.

            Returns:
                A specification of the given tool
            """
            # Make sure this is a valid tool
            if tool_name not in self._tool_list:
                raise ValueError(f'Tool {tool_name} not found in tool catalog')

            # Return the specific tool
            return self._tool_list[tool_name]['tool']

        def query(self) -> Any:
            """
            Query the connected tool catalog (discovery).

            Each tool node appends its descriptors to ``param.tools``
            then raises PreventDefault so the chain continues.  After
            all nodes have run, cb_control throws because no node
            returned success — but param.tools is fully populated.

            Returns:
                The engine-native tool catalog response.
            """
            # Build up the array of tools
            tool_list: List[Any] = []
            for tool in self._tool_list.values():
                tool_list.append(tool['tool'])

            # And return the bare list of tool descriptors (not the full node response)
            return tool_list

        def validate(self, tool_name: str, input: Any) -> None:
            """
            Validate tool input without executing the tool.

            Args:
                tool_name: Tool name as published by discovery.
                input: Tool input payload.
            """
            # Make sure this is a valid tool
            if tool_name not in self._tool_list:
                raise ValueError(f'Tool {tool_name} not found in tool catalog')

            # Build the invoke using the original (un-prefixed) name so the
            # provider's _owns_tool() match works.
            entry = self._tool_list[tool_name]
            param = IInvokeTool.Validate(tool_name=entry['tool_id'], input=input)

            # Call the tool to validate - throws on error
            self._invoker.instance.invoke(param, component_id=entry['node_id'])

        def invoke(self, tool_name: str, args: Dict[str, Any]) -> Any:
            """
            Invoke a tool with a clean args dict.

            Args:
                tool_name: Tool name as published by discovery.
                args: Tool arguments as a dict — already in the shape the
                    underlying tool expects.  Framework-shape conversion
                    happens in the driver wrapper before this is called.

            Returns:
                The tool output (extracted from ``param.output``).
            """
            # Make sure this is a valid tool
            if tool_name not in self._tool_list:
                raise ValueError(f'Tool {tool_name} not found in tool catalog')

            # Guard the outbound call: block before it reaches the tool if
            # the args (agent-generated content) fail policy.
            _check_guard(self._invoker, self._guard_nodes, 'output', args, label=f'tool {tool_name!r}')

            # Build the invoke using the original (un-prefixed) name so the
            # provider's _owns_tool() match works.
            entry = self._tool_list[tool_name]
            param = IInvokeTool.Invoke(tool_name=entry['tool_id'], input=args)

            # Invoke it
            self._invoker.instance.invoke(param, component_id=entry['node_id'])

            # And return the output
            output = getattr(param, 'output', None)

            # Guard the inbound result: block before it reaches the agent
            # if the tool's response fails policy (indirect prompt injection).
            _check_guard(self._invoker, self._guard_nodes, 'input', output, label=f'tool {tool_name!r}')

            return output

    class Memory:
        """Memory host interface backed by IInvokeMemory operations."""

        def __init__(self, invoker, node_id: str, guard_nodes: List[str]) -> None:
            """Create a Memory host service wrapper bound to an engine invoker.

            Args:
                guard_nodes: Guard node ids attached to this agent, resolved
                    once by the caller (``AgentHostServices.__init__``) and
                    shared with ``Tools`` rather than a separate lookup here.
            """
            self._invoker = invoker
            self._node_id = node_id
            self._guard_nodes = guard_nodes

        def put(self, key: str, value: Any) -> Dict[str, Any]:
            # Guard the write: block before it lands in persistent memory if
            # the value (agent-generated content) fails policy.
            _check_guard(self._invoker, self._guard_nodes, 'output', value, label=f'memory.put({key!r})')

            param = IInvokeMemory.Put(input={'key': key, 'value': value})
            self._invoker.instance.invoke(param, component_id=self._node_id)
            return getattr(param, 'output', None) or {}

        def get(self, key: str) -> Dict[str, Any]:
            param = IInvokeMemory.Get(input={'key': key})
            self._invoker.instance.invoke(param, component_id=self._node_id)
            output = getattr(param, 'output', None) or {}

            # Guard the read: block before a poisoned stored value reaches
            # the agent (indirect prompt injection via shared/persistent memory).
            _check_guard(self._invoker, self._guard_nodes, 'input', output, label=f'memory.get({key!r})')

            return output

        def list(self) -> Dict[str, Any]:
            param = IInvokeMemory.List(input={})
            self._invoker.instance.invoke(param, component_id=self._node_id)
            output = getattr(param, 'output', None) or {}

            _check_guard(self._invoker, self._guard_nodes, 'input', output, label='memory.list()')

            return output

        def clear(self, key: Optional[str] = None) -> Dict[str, Any]:
            # Deletion carries no agent-generated or externally-sourced
            # content to check — nothing for a content guard to evaluate.
            param = IInvokeMemory.Clear(input={'key': key} if key else {})
            self._invoker.instance.invoke(param, component_id=self._node_id)
            return getattr(param, 'output', None) or {}

    def __init__(self, invoker):
        """Create host service wrappers bound to an engine invoker."""
        self.llm = AgentHostServices.LLM(invoker)

        # Resolved once and shared: both Tools and Memory guard their calls
        # against the same set of guard nodes attached to this agent.
        guard_nodes = invoker.instance.getControllerNodeIds('guard')
        self.tools = AgentHostServices.Tools(invoker, guard_nodes)

        nodes = invoker.instance.getControllerNodeIds('memory')
        self.memory: Optional[AgentHostServices.Memory] = (
            AgentHostServices.Memory(invoker, nodes[0], guard_nodes) if nodes else None
        )


# ============================================================================
# AGENT CONTEXT
# ============================================================================


# AgentContext is the per-call run scaffolding object passed to every
# driver `_run` and into the `call_llm` / `call_tool` host adapters on
# `AgentBase`.  It is built once per question by `AgentBase.run_agent`
# from a cached `AgentHostServices` (lazy-attached to the IInstance via
# `iInstance._agent_host`) and is passed unchanged through the entire
# run.  Drivers never construct `AgentContext` themselves except inside
# the per-sub-agent loop in `CrewManager`, which builds a sub-context
# inheriting parent run metadata.
#
# Question is intentionally NOT a field on AgentContext.  It travels
# alongside as a separate `_run` parameter so the same context can be
# passed through reentrant `call_llm` / `call_tool` chains without
# carrying a stale "current question" through frames where the question
# means something different (e.g. each LLM call inside a framework loop
# synthesizes a new question from framework messages).
@dataclass(frozen=True)
class AgentContext:
    """Per-call run scaffolding for an agent run.

    Frozen dataclass — built once at the top of `AgentBase.run_agent`
    and passed unchanged through the entire run.  Threading this object
    through reentrant call chains is safe because none of its fields
    ever change during a run.

    Fields:
        invoker: The engine `IInstance` (a.k.a. ``pSelf``) for this run.
        llm: The host LLM channel (cached on the IInstance via
            ``iInstance._agent_host``).
        tools: The host Tools channel.  Read ``context.tools.list`` for
            the prepared flat tool descriptor list — no `discover_tools`
            helper needed.
        memory: The host Memory channel, or ``None`` when no memory node
            is connected.  Drivers that require memory should set
            ``REQUIRES_MEMORY = True`` on their AgentBase subclass —
            `AgentBase.run_agent` enforces the requirement at first
            question.
        run_id: Unique identifier for this run.  Stamped fresh per call.
        pipe_id: The pipeline instance id (from ``iInstance.instance.pipeId``).
            Useful for per-pipe diagnostics; identifies which concurrent
            pipeline instance is running.
        framework: The driver's `FRAMEWORK` class attribute (e.g. ``'crewai'``,
            ``'langchain'``, ``'wave'``).  Stamped from ``self.FRAMEWORK``
            at construction time.
        started_at: ISO-8601 timestamp of when the run started.
        invoked_tools: Names of every host tool invoked through
            ``AgentBase.call_tool`` during this run.  The list is the ONE
            mutable field on this otherwise-frozen context (frozen forbids
            reassigning the attribute, but the list contents may change);
            ``call_tool`` appends to it and ``run_agent`` reads its length to
            enforce the optional ``require_tool_call`` guard.  Appending is
            thread-safe under the GIL, which matters because some drivers
            (e.g. the wave executor) invoke tools from parallel threads.
            Sub-agent drivers that build their own ``AgentContext`` (crewai
            manager, deepagent) pass the parent's list here so delegated tool
            calls count toward the parent run's guard.
    """

    invoker: Any

    # Host channels — flattened from AgentHostServices for ergonomic access
    llm: 'AgentHostServices.LLM'
    tools: 'AgentHostServices.Tools'
    memory: Optional['AgentHostServices.Memory']

    # Run metadata
    run_id: str
    pipe_id: int
    framework: str
    started_at: str

    # Mutable run-scoped tally of tool invocations (see docstring).  Trailing
    # defaulted field so all existing keyword constructions stay valid;
    # compare=False keeps it out of the generated __eq__/__hash__ so the frozen
    # context stays hashable (a mutable list would otherwise make __hash__ raise).
    invoked_tools: List[str] = field(default_factory=list, compare=False)
