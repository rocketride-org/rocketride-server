# =============================================================================
# RocketRide Engine
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

"""Mock FalkorDB client for node testing — no real server is contacted."""

from __future__ import annotations


class _MockQueryResult:
    def __init__(self, result_set=None, header=None):
        self.result_set = result_set or []
        self.header = header or []
        self.nodes_created = 0
        self.nodes_deleted = 0
        self.relationships_created = 0
        self.relationships_deleted = 0
        self.properties_set = 0
        self.properties_removed = 0
        self.labels_added = 0
        self.indices_created = 0


class _MockGraph:
    def __init__(self, name):
        self.name = name

    def query(self, q, params=None, timeout=None, **kwargs):
        return _MockQueryResult(result_set=[['mock']], header=[[1, 'value']])

    def ro_query(self, q, params=None, timeout=None, **kwargs):
        return _MockQueryResult(result_set=[['mock']], header=[[1, 'value']])


class FalkorDB:
    def __init__(self, host='localhost', port=6379, username=None, password=None, ssl=False, **kwargs):
        self.host = host
        self.port = port

    def select_graph(self, name):
        return _MockGraph(name)

    def list_graphs(self):
        return ['mock-graph']

    def close(self):
        pass


__all__ = ['FalkorDB']
