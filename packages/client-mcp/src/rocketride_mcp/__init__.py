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
RocketRide MCP (Model Context Protocol) Server Package.

This package provides an MCP server implementation that wraps the RocketRide client,
exposing RocketRide data pipelines as dynamically-discovered MCP tools for AI assistants
and LLM integrations. The server connects to a RocketRide instance, retrieves available
pipeline tasks, and allows AI agents to send files through those pipelines for processing.

Primary responsibilities include:
- Wrapping RocketRideClient to provide MCP-compliant tool discovery and execution
- Dynamically exposing running RocketRide pipeline tasks as callable MCP tools
- Managing file upload and processing through RocketRide pipelines
- Providing built-in convenience tools for common document processing operations

Public modules:
- server: Contains run_server() and main() entry points for the MCP stdio server
"""

from . import server

__all__ = ['server']
