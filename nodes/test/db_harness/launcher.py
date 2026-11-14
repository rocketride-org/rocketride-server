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

"""Run ``ai/eaas.py`` with the TEST-ONLY ``extension.saas`` stand-in importable.

The engine ignores ``PYTHONPATH``, so the harness directory is put on ``sys.path``
here, then the real server entry point runs unchanged::

    engine launcher.py --saas --host=127.0.0.1 --port=0 ...

``RR2203_EAAS``      path of ``eaas.py`` to run.
``RR2203_EXTRA_CA``  PEM of the throwaway CA that signed the fake broker. It is
                     ADDED to the default trust of the process (verification stays
                     on); a deployment gets the same effect from ``SSL_CERT_FILE``,
                     which cannot be used here because ``uv`` reads it too.
"""

import os
import runpy
import ssl
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

_extra_ca = os.environ.get('RR2203_EXTRA_CA')
if _extra_ca:
    _original = ssl.create_default_context

    def _trusting(*args, **kwargs):
        context = _original(*args, **kwargs)
        purpose = args[0] if args else kwargs.get('purpose', ssl.Purpose.SERVER_AUTH)
        if purpose == ssl.Purpose.SERVER_AUTH and not kwargs.get('cafile') and not kwargs.get('capath'):
            context.load_verify_locations(_extra_ca)
        return context

    ssl.create_default_context = _trusting
    ssl._create_default_https_context = _trusting

_eaas = os.environ['RR2203_EAAS']
sys.argv = [_eaas] + sys.argv[1:]
runpy.run_path(_eaas, run_name='__main__')
