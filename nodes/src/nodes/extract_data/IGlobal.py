# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

from typing import List
from rocketlib import IGlobalBase, warning
from ai.common.config import Config


class IGlobal(IGlobalBase):
    fields: List = []

    def beginGlobal(self) -> None:
        # Get the confif info
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Filter out fields with empty name or type
        self.fields = []
        for field in config.get('fields', []):
            field_name = field.get('column', '')
            field_type = field.get('type', '')
            if not field_name or not field_type:
                warning(f'Skipping incorrectly defined field with name "{field_name}" and type "{field_type}"')
                continue
            self.fields.append(field)

    def endGlobal(self) -> None:
        pass
