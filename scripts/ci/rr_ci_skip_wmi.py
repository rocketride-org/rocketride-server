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

"""Windows CI start-up hook: stop the engine's CPython 3.12 from querying WMI.

The Windows CI job copies this module and ``rr_ci_skip_wmi.pth`` into the
engine's ``site-packages`` before the tests. ``site`` then imports it in every
engine Python process of the test run (test servers, task children,
``engine -m pytest`` and its workers, ``engine -c``) before any other code, so
the patch is in place before the first ``platform`` call.

``platform`` asks WMI (``_wmi.exec_query``) for the Windows version and the CPU
and treats an ``OSError`` as "WMI unavailable": it then reads
``sys.getwindowsversion()``, runs one ``cmd /c ver`` and reads the
``PROCESSOR_*`` environment variables instead. Making ``exec_query`` raise
``OSError`` at once selects that path.

Workaround for the CPython 3.12 ``_wmi`` timeout race (python/cpython#130727):
after a query times out, its helper thread can close an unrelated handle of the
process. Fixed in 3.13 by python/cpython#134313. Remove this module, its
``.pth`` file, its test and the workflow steps once the engine runs Python 3.13
or later.
"""

import sys

_SKIP_MARK = '_rr_ci_skip_wmi'


def _wmi_unavailable(query):
    """Stand-in for ``_wmi.exec_query``; reports WMI as unavailable.

    Args:
        query (str): The WQL query ``platform`` asked for; ignored.

    Raises:
        OSError: Always, so the caller takes its non-WMI path.
    """
    raise OSError('WMI queries are disabled in this CI run')


setattr(_wmi_unavailable, _SKIP_MARK, True)


def skip_wmi_queries():
    """Replace ``_wmi.exec_query`` with a function that raises ``OSError``.

    Does nothing off Windows, on Python 3.13 or later, when ``_wmi`` is not
    importable, or when the replacement is already installed. Never raises.

    Returns:
        bool: True when ``exec_query`` is now the replacement.
    """
    try:
        if sys.platform != 'win32' or sys.version_info >= (3, 13):
            return False

        import _wmi

        if getattr(_wmi.exec_query, _SKIP_MARK, False):
            return True
        _wmi.exec_query = _wmi_unavailable
        return True
    except Exception:
        return False


skip_wmi_queries()
