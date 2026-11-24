# =============================================================================
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
Global handler for the doors probe: what one control's IGlobal may read.

``beginGlobal`` reads the control's one value (``label``) from
``self.config``, the identity record and the keys the view flags as
parameters, and records that the view refuses a write. It never reads a
parameter: the node lint refuses that at build time, and the instance shows
the runtime refusal of the same view (``IGlobal.config.greeting`` raises
``ConfigError``). The record is rebuilt from the config on any replica, so it
is a cache in the sense the IGlobal allows.

``stashed`` is the one deliberate violation: a call can leave its own doors
here so a LATER call of the same control can try them, which proves a door
reaches nothing once its binding has ended. A real node never does this.
"""

from typing import Any, Dict, Optional, Tuple

from rocketlib import IGlobalBase, NodeFiles, NodeState


class IGlobal(IGlobalBase):
    """
    The control's IGlobal: the config record, and the doors a call stashed for the next one.
    """

    #: What beginGlobal saw through self.config (set per control, never shared).
    observed: Optional[Dict[str, Any]] = None

    #: The doors an earlier call of this control left behind (the stale-binding probe).
    stashed: Optional[Tuple[NodeState, NodeFiles]] = None

    def beginGlobal(self) -> None:
        """
        Read the control's configuration once, recording each read and each refusal.
        """
        config = self.config

        # Step 1: the control's own values and the identity record every view carries
        observed: Dict[str, Any] = {
            'label': config.label,
            'node': dict(config.node._asdict()),
            'keys': sorted(config),
            'paramKeys': sorted(config.param_keys),
        }

        # Step 2: the view is read-only; a write must be refused
        try:
            config.label = 'changed'
            observed['configWrite'] = {'refused': False}
        except TypeError as e:
            observed['configWrite'] = {'refused': True, 'error': f'TypeError: {e}'}

        # Step 3: the record and an empty stash, both owned by this control
        self.observed = observed
        self.stashed = None

    def endGlobal(self) -> None:
        """
        Drop what beginGlobal and the calls left on the control.
        """
        # A stashed door names an ended binding; nothing closes it, it is just let go
        self.stashed = None
        self.observed = None
