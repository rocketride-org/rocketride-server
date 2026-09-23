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

from rocketlib import AVI_ACTION, IInstanceBase
from .IGlobal import IGlobal


class LaneConflictError(RuntimeError):
    """Raised when a second media lane BEGINs while the other is still active."""


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        from .player import Player

        self._audio = Player(lock=self.IGlobal.lock)
        self._active_lane = None

    def endInstance(self):
        self._audio = None
        self._active_lane = None

    def _guard_lane(self, lane: str, action: int):
        # Single choke point for the lane-conflict policy (issue #1966): one
        # Player can only play one lane at a time, and a second concurrent
        # BEGIN would deadlock its non-reentrant lock instead of erroring.
        # Change the policy or LaneConflictError here only. Precondition check
        # only - state is committed in _commit_lane, only after writeAVI
        # actually succeeds, so a raised BEGIN/END never wedges the state.
        # A repeated BEGIN on the SAME lane re-enters the Player's lock exactly
        # like a different lane would, so any active lane blocks every BEGIN,
        # not just a mismatched one.
        if action == AVI_ACTION.BEGIN and self._active_lane is not None:
            raise LaneConflictError(
                f'audio_player: cannot start the {lane} lane, this object already has an '
                f'active {self._active_lane} lane; only one lane can play at a time'
            )

    def _commit_lane(self, lane: str, action: int):
        if action == AVI_ACTION.BEGIN:
            self._active_lane = lane
        elif action == AVI_ACTION.END and self._active_lane == lane:
            self._active_lane = None

    def writeAudio(self, action: int, mimeType: str, buffer: bytes):
        # Use the standard AVI write method for audio
        self._guard_lane('audio', action)
        self._audio.writeAVI(action, mimeType, buffer)
        self._commit_lane('audio', action)

    def writeVideo(self, action: int, mimeType: str, buffer: bytes):
        # Use the standard AVI write method for video
        self._guard_lane('video', action)
        self._audio.writeAVI(action, mimeType, buffer)
        self._commit_lane('video', action)
