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
