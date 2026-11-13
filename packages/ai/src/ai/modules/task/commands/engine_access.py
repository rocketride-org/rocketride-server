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
Engine access shared by the commands that run a request through a control.

One rule for the data path, the profiler and ``process()``: a request through
a DORMANT control (its engine stopped on the inactivity timer, or crashed after
it confirmed running) starts the engine again with the team's CURRENT secrets,
so the restart re-checks the caller's access to the team the way the explicit
restart does. ``get_control`` grants a run's owner access by identity alone,
without asking whether they are still on the team; this is where that question
is asked.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..task_control import TaskControl
    from ..task_engine import TaskEngine


async def engine_for(conn, control: 'TaskControl', perm: str) -> 'TaskEngine':
    """
    The engine a request through ``control`` runs on, started again when it is dormant.

    Args:
        conn: The command connection (``verify_team_permission`` and ``_server``).
        control: The control the request resolved.
        perm: The team permission the request needs (``'task.data'``,
            ``'task.control'``).

    Returns:
        TaskEngine: The engine under the control's hold.

    Raises:
        PermissionError: The caller no longer holds ``perm`` on the team.
        TaskError: The engine could not start (``ensure_engine``).
    """
    # Step 1: a restart loads the team's current secrets: re-check the team
    if control.dormant:
        conn.verify_team_permission(control.teamId, perm)

    # Step 2: the live engine, or the one started again under the same key (plan 7.2)
    return await conn._server.ensure_engine(control)
