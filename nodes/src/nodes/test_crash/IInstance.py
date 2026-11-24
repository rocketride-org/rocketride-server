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
Instance handler for the crash test node: the text it receives says how its task process ends.

Each way is one a real node can die of, and the server has to tell them apart:
a crash it reports with a dump, an exit it reports without one, and a stop it
did not ask for.
"""

import ctypes
import os
import signal

from rocketlib import IInstanceBase


class IInstance(IInstanceBase):
    """
    Ends the task process the way the incoming text names. Any other text does nothing.
    """

    def writeText(self, text: str):
        """
        End the process as ``text`` asks.

        - ``segv``: a read of address 0. (``ctypes.string_at(0)`` would only
          raise ``OSError`` on Windows, where ctypes guards its foreign calls.)
        - ``abort``: ``os.abort()``.
        - ``failfast``: Windows ``RaiseFailFastException``, which skips every
          handler in the process.
        - ``sigkill``: ``SIGKILL``, which no handler sees either.
        - ``exit``: ``os._exit(-1)``, an exit and not a crash.
        - ``sigterm``: a cancel the server did not ask for.

        Args:
            text: The way to end, one of the names above.
        """
        if text == 'segv':
            ctypes.c_int.from_address(0).value
        elif text == 'abort':
            os.abort()
        elif text == 'failfast':
            ctypes.windll.kernel32.RaiseFailFastException(None, None, 0)
        elif text == 'sigkill':
            os.kill(os.getpid(), signal.SIGKILL)
        elif text == 'exit':
            os._exit(-1)
        elif text == 'sigterm':
            os.kill(os.getpid(), signal.SIGTERM)
