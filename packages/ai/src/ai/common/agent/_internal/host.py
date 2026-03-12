"""
Framework-facing host services for agent framework drivers.

Wraps the engine control-plane invoke seam into a small interface:
  - host.llm.invoke(...)
  - host.tools.query/validate/invoke(...)
"""

from __future__ import annotations

from typing import Any, List, Dict

from rocketlib.types import IInvokeLLM, IInvokeTool

class AgentHostServices:
    class LLM:
        """LLM host interface backed by `invoke('llm', ...)`."""

        def __init__(self, invoker):
            """
            Initialize the LLM host service wrapper and bind it to the provided engine invoker.
            
            Parameters:
                invoker: Engine invoker used to access controller nodes.
            
            Raises:
                ValueError: If the number of connected LLM controller nodes is not exactly 1.
            """
            node = invoker.instance.getControllerNodeIds('llm')

            # There needs to be exactly 1 llm node
            if len(node) != 1:
                raise ValueError('You must have 1, and only 1 llm node connected to your agent')

            # Save it
            self._invoker = invoker
            self._llm = node[0]

        def invoke(self, param: IInvokeLLM) -> Any:
            """
            Invoke the host LLM control-plane operation on the configured LLM node.
            
            Parameters:
                param (IInvokeLLM): The LLM request object (for example, op="ask") to send to the host.
            
            Returns:
                The engine-native response object from the host LLM node.
            """
            # Call the self._llm nodeId, type llm with the given param
            return self._invoker.instance.invoke('llm', param, nodeId=self._llm)

    class Tools:
        """Tool host interface backed by `invoke('tool', ...)`."""

        _tool_nodes: List[str] = []
        _tool_list: Dict[Any] = {}

        def __init__(self, invoker):
            """
            Initialize the Tools host wrapper and build a catalog of available tools across tool controller nodes.
            
            Stores the provided engine invoker, discovers controller node IDs for the 'tool' role, queries each tool node for its declared tools, and populates an internal mapping from tool name to a dictionary containing the hosting node_id and the tool descriptor. Invocation errors when querying nodes are ignored; discovered tool descriptors populate the catalog.
            
            Parameters:
                invoker: Engine invoker object used to query and invoke tool controller nodes.
            """
            self._invoker = invoker
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

                # Add the tools
                for tool in param.tools:
                    self._tool_list[tool['name']] = {'node_id': tool_node, 'tool': tool}

            # And done
            return

        def get(self, tool_name: str) -> Any:
            """
            Retrieve the tool descriptor for a named tool from the cached tool catalog.
            
            Parameters:
                tool_name (str): The registered name of the tool to retrieve.
            
            Returns:
                The tool descriptor object for `tool_name`.
            
            Raises:
                ValueError: If `tool_name` is not found in the tool catalog.
            """
            # Make sure this is a valid tool
            if tool_name not in self._tool_list:
                raise ValueError(f'Tool {tool_name} not found in tool catalog')

            # Return the specific tool
            return self._tool_list[tool_name]['tool']

        def query(self) -> Any:
            """
            Get a list of available tool descriptors from the host's tool catalog.
            
            Returns:
                A list of tool descriptor objects (one per registered tool) as provided by their hosting nodes.
            """
            # Build up the array of tools
            tool_list: List[Any] = []
            for tool in self._tool_list.values():
                tool_list.append(tool['tool'])

            # And return the bare list of tool descriptors (not the full node response)
            return tool_list

        def validate(self, tool_name: str, input: Any) -> None:
            """
            Validate the input for a named tool without executing its action.
            
            Parameters:
                tool_name (str): Name of the tool as published by discovery.
                input (Any): Payload to be validated by the tool.
            
            Raises:
                ValueError: If `tool_name` is not present in the tool catalog.
                Exception: Any error raised by the underlying tool validation invocation.
            """
            # Make sure this is a valid tool
            if tool_name not in self._tool_list:
                raise ValueError(f'Tool {tool_name} not found in tool catalog')

            # Build the invoke
            param = IInvokeTool.Validate(tool_name=tool_name, input=input)

            # Call the tool to validate - throws on error
            self._invoker.instance.invoke('tool', param, nodeId=self._tool_list[tool_name]['node_id'])

        def invoke(self, tool_name: str, input: Any) -> Any:
            """
            Invoke the named tool using its hosting node with the provided input.
            
            Parameters:
                tool_name (str): Name of the tool as published by discovery.
                input (Any): Input payload passed to the tool.
            
            Returns:
                Any: The tool's output, or None if the tool produced no output.
            """
            # Make sure this is a valid tool
            if tool_name not in self._tool_list:
                raise ValueError(f'Tool {tool_name} not found in tool catalog')

            # Build the invoke
            param = IInvokeTool.Invoke(tool_name=tool_name, input=input)

            # Invoke it
            self._invoker.instance.invoke('tool', param, nodeId=self._tool_list[tool_name]['node_id'])

            # And return the output
            return getattr(param, 'output', None)

    def __init__(self, invoker):
        """
        Initialize AgentHostServices by binding LLM and Tools wrappers to an engine invoker.
        
        Creates the `llm` and `tools` attributes, each constructed with the provided invoker.
        
        Parameters:
            invoker: Engine invoker used to construct and bind the host service wrappers.
        """
        self.llm = AgentHostServices.LLM(invoker)
        self.tools = AgentHostServices.Tools(invoker)
