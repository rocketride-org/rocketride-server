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

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase, IJson, OPEN_MODE


class IGlobal(IGlobalBase):
    process: Any = None
    agent: Any = None
    role: str = 'Assistant'
    task_description: str = ''
    goal: str = ''
    backstory: str = ''
    expected_output: str = ''

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        from crewai import Process

        self.process = Process.sequential

        conn_config = IJson.toDict(self.glb.connConfig) if self.glb.connConfig else {}

        self.goal = str(conn_config.get('goal') or '').strip()
        self.backstory = str(conn_config.get('backstory') or '').strip()

        if self.glb.logicalType == 'agent_crewai_manager':
            from .crewai import ManagerDriver

            self.agent = ManagerDriver(self)
        else:
            self.role = str(conn_config.get('role') or 'Assistant').strip() or 'Assistant'
            self.task_description = str(conn_config.get('task_description') or '').strip()
            self.expected_output = str(conn_config.get('expected_output') or '').strip()
            from .crewai import CrewDriver

            self.agent = CrewDriver(self, process=self.process, role=self.role, task_description=self.task_description, goal=self.goal, backstory=self.backstory, expected_output=self.expected_output)

    def endGlobal(self) -> None:
        self.agent = None
        self.process = None
        self.role = 'Assistant'
        self.task_description = ''
        self.goal = ''
        self.backstory = ''
        self.expected_output = ''
