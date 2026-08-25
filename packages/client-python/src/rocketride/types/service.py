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
Protocol capability flags for service drivers.

Each flag is a single bit in a uint32 bitmask describing what a service
driver supports. Values are returned by the engine in the ``capabilities``
field of a service definition and can be tested with bitwise AND.

Usage:
    from rocketride.types import PROTOCOL_CAPS

    services = await client.get_services()
    svc = services['services']['my_driver']
    if svc['capabilities'] & PROTOCOL_CAPS.GPU:
        print('Driver requires a GPU')
"""

from enum import Flag
from typing import Any, Dict, List, Optional, TypedDict


# ============================================================================
# Service Definition Types
# ============================================================================


class SERVICE_SECTION(TypedDict):
    """JSON Schema / UI schema pair for a configuration section of a service driver."""

    schema: Dict[str, Any]  # JSON Schema describing the section's configurable properties
    ui: Dict[str, Any]  # UI schema hints for rendering in the pipeline editor


class SERVICE_INVOKE_SLOT(TypedDict, total=False):
    """Invoke slot descriptor for a service that supports control-plane invoke."""

    description: str  # Human-readable description of what this slot expects
    min: int  # Minimum number of connections required (0 = optional)
    max: int  # Maximum number of connections allowed (omitted = unlimited)


class SERVICE_INPUT_LANE(TypedDict, total=False):
    """Describes one input lane and its possible output lanes."""

    lane: str  # The input lane name
    output: List[Dict[str, str]]  # Output lanes this input can produce


class SERVICE_SUMMARY(TypedDict, total=False):
    """
    A service SUMMARY as returned per-entry by the bulk ``rrext_services``
    call: the display fields a client needs to render the canvas / node
    palette. The node's icon is referenced by id into the response's
    deduplicated ``icons`` table. Configuration schema is NOT included —
    fetch the full SERVICE_DEFINITION via ``get_service()`` when
    configuring a node.

    Usage:
        services = await client.get_services()
        ocr = services['services']['ocr']
        print(ocr['title'], ocr['classType'])
    """

    title: str  # Human-readable display name
    protocol: str  # Protocol URI scheme (e.g. "filesys://", "agent_rocketride://")
    prefix: str  # URL prefix used for default URL mapping
    plans: Optional[List[str]]  # Account plans this driver is available for (None = all plans)
    capabilities: int  # Bitmask of PROTOCOL_CAPS flags
    classType: List[str]  # Categorisation tags (e.g. ["source"], ["agent", "tool"])
    actions: int  # Bitmask of supported UI actions (deletion, export, download)
    description: str  # Human-readable description of the driver
    lanes: Dict[str, List[str]]  # Lane mapping: input lane name -> list of output lane names
    input: List[SERVICE_INPUT_LANE]  # Structured input/output lane definitions
    invoke: Dict[str, SERVICE_INVOKE_SLOT]  # Control-plane invoke slot definitions
    tile: Dict[str, Any]  # Tile/card rendering hint for the pipeline editor
    icon: str  # Opaque id into the response's 'icons' table (absent = no icon)
    documentation: str  # External documentation URL


class SERVICE_DEFINITION(SERVICE_SUMMARY, total=False):
    """
    A FULL service definition, returned by ``get_service()``.

    Extends the summary with dynamic configuration section keys (e.g.
    "Pipe", "Source", "Global") that each hold a SERVICE_SECTION with
    ``schema`` and ``ui``. TypedDict cannot express dynamic keys, so
    access sections via ``definition.get(section_name)``.
    """


class SERVICES_RESPONSE(TypedDict, total=False):
    """
    Response from ``get_services()``: service summaries plus the
    deduplicated icon table their ``icon`` ids point into.
    """

    services: Dict[str, SERVICE_SUMMARY]
    icons: Dict[str, str]  # Icon id -> raw SVG text (sanitize before DOM use)
    version: int  # Engine services version


# ============================================================================
# Validation Types
# ============================================================================


class VALIDATION_ERROR(TypedDict, total=False):
    """A single validation error or warning from pipeline validation."""

    message: str  # Human-readable error/warning message
    id: str  # Component ID that caused the issue (if applicable)


class VALIDATION_RESULT(TypedDict, total=False):
    """
    Result of a pipeline validation via ``validate()``.

    The engine validates structure — required fields and component
    references. The result contains any errors and warnings found.
    """

    errors: List[VALIDATION_ERROR]  # Validation errors — pipeline will not execute with these
    warnings: List[VALIDATION_ERROR]  # Validation warnings — pipeline may still execute


# ============================================================================
# Protocol Capability Flags
# ============================================================================


class PROTOCOL_CAPS(Flag):
    """Protocol capability bitmask flags for service drivers."""

    NONE = 0

    SECURITY = 1 << 0  # Supports the file permissions interface
    FILESYSTEM = 1 << 1  # Is a filesystem interface
    SUBSTREAM = 1 << 2  # Supports the substream interface
    NETWORK = 1 << 3  # Uses a network interface
    DATANET = 1 << 4  # Uses datanet or streamnet interfaces
    SYNC = 1 << 5  # Uses delta queries to track changes
    INTERNAL = 1 << 6  # Internal — will not be returned in services.json
    CATALOG = 1 << 7  # Supports data catalog operations
    NOMONITOR = 1 << 8  # Do not monitor for excessive failures
    NOINCLUDE = 1 << 9  # Source endpoint does not use include
    INVOKE = 1 << 10  # Driver supports the invoke function
    REMOTING = 1 << 11  # Driver supports remoting execution
    GPU = 1 << 12  # Driver requires a GPU
    NOSAAS = 1 << 13  # Driver is not SaaS compatible
    FOCUS = 1 << 14  # Focus on this driver
    DEPRECATED = 1 << 15  # Driver is deprecated
    EXPERIMENTAL = 1 << 16  # Driver is experimental
