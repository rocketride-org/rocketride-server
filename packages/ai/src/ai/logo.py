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
The RocketRide ASCII art banner — one definition, printed by every process
whose stdout a human reads: the EaaS server on startup (operator console)
and the task node on launch (the run log's console, so every recorded run
opens with it).
"""

# ASCII art banner. Raw string: the backslashes are the art.
LOGO = r"""
       ______            _        _   _____  _     _
       |  __ \          | |      | | |  __ \(_)   | |
       | |__) |___   ___| | _____| |_| |__) |_  __| | ___
       |  _  // _ \ / __| |/ / _ \ __|  _  /| |/ _` |/ _ \
       | | \ \ (_) | (__|   <  __/ |_| | \ \| | (_| |  __/
       |_|  \_\___/ \___|_|\_\___|\__|_|  \_\_|\__,_|\___|


            Copyright (c) 2026 Aparavi Software AG
                    All rights reserved
    """
