# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Chart (Chart.js) tool node instance.

Binds the pipeline LLM to the ``ChartjsDriver`` and delegates tool
invocation.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase
from rocketlib.types import IInvokeLLM

from .IGlobal import IGlobal


def _make_llm_invoker(instance: Any) -> Any:
    """Create an LLM-invoking callable bound to the pipeline instance.

    Returns a callable that accepts a ``Question`` and returns the LLM
    response text.
    """
    llm_nodes = instance.getControllerNodeIds('llm')
    if not llm_nodes:
        return None
    llm_node_id = llm_nodes[0]

    def invoke_llm(question: Any) -> str:
        result = instance.invoke('llm', IInvokeLLM(op='ask', question=question), nodeId=llm_node_id)
        if hasattr(result, 'getText') and callable(result.getText):
            return (result.getText() or '').strip()
        return str(result).strip()

    return invoke_llm


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        driver = getattr(self.IGlobal, 'driver', None)
        if driver is None:
            raise RuntimeError('chart_chartjs: driver not initialized')

        # Bind the LLM invoker before each invocation
        if driver._llm_invoke is None:
            llm_invoker = _make_llm_invoker(self.instance)
            if llm_invoker is None:
                raise RuntimeError('Chart generator requires an LLM node connected to the pipeline.')
            driver.set_llm_invoker(llm_invoker)

        return driver.handle_invoke(param)
