# =============================================================================
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the 'Software'), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""Reference multimodal tool: returns SHA-256 of a passed-in attachment.

Fixture for the multimodal-tool integration tests in Slices I and J.
Declares one ``format: 'rocketride-attachment'`` input slot; the
dispatcher pre-resolves the path to ``{path, mime, bytes}`` before
calling :meth:`sha256`.
"""

from __future__ import annotations

import hashlib

from rocketlib import IInstanceBase, tool_function

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Stateless SHA-256-of-attachment tool."""

    IGlobal = IGlobal

    @tool_function(
        description='Compute SHA-256 of a binary attachment.',
        input_schema={
            'type': 'object',
            'properties': {
                'document': {
                    'type': 'string',
                    'format': 'rocketride-attachment',
                    'description': 'Filestore path to a binary; the dispatcher resolves it to bytes.',
                    'x-rocketride-mimes': ['*/*'],
                },
            },
            'required': ['document'],
        },
    )
    def sha256(self, input_obj):
        """Return the SHA-256 hex digest and byte length of the input file."""
        data = input_obj['document']['bytes']
        return {
            'sha256': hashlib.sha256(data).hexdigest(),
            'size_bytes': len(data),
        }
