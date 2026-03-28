"""
Framework-facing host services for agent framework drivers.

Wraps the engine control-plane invoke seam into a small interface:
  - host.llm.invoke(...)
  - host.tools.query/validate/invoke(...)
  - host.memory.put/get/list/clear(...)
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from rocketlib.types import IInvokeLLM, IInvokeTool


class AgentHostServices:
    class LLM:
        """LLM host interface backed by `invoke('llm', ...)`."""

        def __init__(self, invoker):
            """Create an LLM host service wrapper bound to an engine invoker."""
            node = invoker.instance.getControllerNodeIds('llm')

            # There needs to be exactly 1 llm node
            if len(node) != 1:
                raise ValueError('You must have 1, and only 1 llm node connected to your agent')

            # Save it
            self._invoker = invoker
            self._llm = node[0]

        def invoke(self, param: IInvokeLLM) -> Any:
            """
            Invoke the host LLM control-plane operation.

            Args:
                param: An `IInvokeLLM` request object (e.g. op="ask").

            Returns:
                The engine-native response object.
            """
            # Call the self._llm nodeId, type llm with the given param
            return self._invoker.instance.invoke('llm', param, nodeId=self._llm)

    class Tools:
        """Tool host interface backed by `invoke('tool', ...)`."""

        _tool_nodes: List[str] = []
        _tool_list: Dict[Any] = {}

        def __init__(self, invoker):
            """Create a Tools host service wrapper bound to an engine invoker."""
            self._invoker = invoker
            self._tool_list: Dict[Any] = {}
            self._tool_nodes = self._invoker.instance.getControllerNodeIds('tool')

            # For every tool node
            for tool_node in self._tool_nodes:
                # Get this nodes tool list
                param = IInvokeTool.Query()
                try:
                    self._invoker.instance.invoke('tool', param, nodeId=tool_node)
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

            # And done initializing the tool list
            return

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
            self._invoker.instance.invoke('tool', param, nodeId=entry['node_id'])

        def invoke(self, tool_name: str, input: Any) -> Any:
            """
            Invoke a tool with the given input payload.

            Args:
                tool_name: Tool name as published by discovery.
                input: Tool input payload.

            Returns:
                The tool output (extracted from ``param.output``).
            """
            # Make sure this is a valid tool
            if tool_name not in self._tool_list:
                raise ValueError(f'Tool {tool_name} not found in tool catalog')

            # Build the invoke using the original (un-prefixed) name so the
            # provider's _owns_tool() match works.
            entry = self._tool_list[tool_name]
            param = IInvokeTool.Invoke(tool_name=entry['tool_id'], input=input)

            # Invoke it
            self._invoker.instance.invoke('tool', param, nodeId=entry['node_id'])

            # And return the output
            return getattr(param, 'output', None)

    class Memory:
        """Memory host interface — thin wrapper over the memory_internal node."""

        def __init__(self, invoker, node_id: str) -> None:
            """Create a Memory host service wrapper bound to an engine invoker."""
            self._invoker = invoker
            self._node_id = node_id

        def _invoke(self, tool_name: str, args: dict) -> Dict[str, Any]:
            param = IInvokeTool.Invoke(tool_name=tool_name, input=args)
            self._invoker.instance.invoke('memory', param, nodeId=self._node_id)
            return getattr(param, 'output', None) or {}

        def put(self, key: str, value: Any) -> Dict[str, Any]:
            return self._invoke('memory.put', {'key': key, 'value': value})

        def get(self, key: str) -> Dict[str, Any]:
            return self._invoke('memory.get', {'key': key})

        def list(self) -> Dict[str, Any]:
            return self._invoke('memory.list', {})

        def clear(self, key: Optional[str] = None) -> Dict[str, Any]:
            return self._invoke('memory.clear', {'key': key} if key else {})

    def __init__(self, invoker):
        """Create host service wrappers bound to an engine invoker."""
        self.llm = AgentHostServices.LLM(invoker)
        self.tools = AgentHostServices.Tools(invoker)
        nodes = invoker.instance.getControllerNodeIds('memory')
        self.memory: Optional[AgentHostServices.Memory] = AgentHostServices.Memory(invoker, nodes[0]) if nodes else None
