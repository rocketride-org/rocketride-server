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

import sys
import types
from pathlib import Path


NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

if 'depends' not in sys.modules:
    depends = types.ModuleType('depends')
    depends.depends = lambda _requirements: None
    sys.modules['depends'] = depends

if 'rocketlib' not in sys.modules:
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IEndpointBase = type('IEndpointBase', (), {})
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config', SOURCE='source')
    rocketlib.warning = lambda _message: None

    class IJson(dict):
        def toDict(self):
            return dict(self)

    class Entry:
        def __init__(self, *, url, name):
            self.url = url
            self.name = name
            self._metadata = IJson()

        @property
        def metadata(self):
            return self._metadata

        def fromDict(self, value):
            self._metadata = IJson(value['metadata'])

    rocketlib.IJson = IJson
    rocketlib.getObject = lambda *, obj: Entry(**obj)
    rocketlib.monitorCompleted = lambda _count: None
    rocketlib.monitorFailed = lambda _count: None
    rocketlib.monitorOther = lambda *_args: None
    rocketlib.monitorStatus = lambda _message: None
    sys.modules['rocketlib'] = rocketlib

if 'ai.common.config' not in sys.modules:
    ai = sys.modules.setdefault('ai', types.ModuleType('ai'))
    common = types.ModuleType('ai.common')
    config = types.ModuleType('ai.common.config')
    config.Config = type('Config', (), {'getNodeConfig': staticmethod(lambda _logical_type, _config: {})})
    ai.common = common
    common.config = config
    sys.modules['ai.common'] = common
    sys.modules['ai.common.config'] = config

if 'ai.web' not in sys.modules:
    web = types.ModuleType('ai.web')
    web.WebServer = type('WebServer', (), {})
    sys.modules['ai'].web = web
    sys.modules['ai.web'] = web

if 'fastapi.responses' not in sys.modules:
    fastapi = types.ModuleType('fastapi')
    responses = types.ModuleType('fastapi.responses')

    class Request:
        pass

    class _Response:
        def __init__(self, content='', status_code=200):
            self.body = content.encode() if isinstance(content, str) else content
            self.status_code = status_code

    responses.PlainTextResponse = _Response
    fastapi.Request = Request
    fastapi.responses = responses
    sys.modules['fastapi'] = fastapi
    sys.modules['fastapi.responses'] = responses
