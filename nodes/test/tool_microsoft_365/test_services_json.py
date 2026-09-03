# =============================================================================
# RocketRide Engine
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

import json
import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_microsoft_365'
SERVICES = sorted(ROOT.glob('services.*.json'))


def _load(p):
    return json.loads(re.sub(r'^\s*//.*$', '', p.read_text(encoding='utf-8'), flags=re.M))


def test_services_exist():
    assert [p.name for p in SERVICES]  # non-empty once Task 5 lands


@pytest.mark.parametrize('path', SERVICES, ids=lambda p: p.name)
def test_service_shape(path):
    doc = _load(path)
    assert doc['classType'] == ['tool']
    assert doc['capabilities'] == ['invoke']
    assert doc['register'] == 'filter'
    assert doc['path'].startswith('nodes.tool_microsoft_365.')
    assert doc['protocol'].startswith('tool_') and doc['protocol'].endswith('://')
    # fields: dict of defs; shape properties: name strings only (engine jsoncpp aborts otherwise)
    assert isinstance(doc['fields'], dict)
    for section in doc['shape']:
        for prop in section['properties']:
            assert isinstance(prop, str)
    # every service exposes authType and its access tier in the Pipe section
    props = doc['shape'][0]['properties']
    assert 'microsoft.authType' in props
    prefix = doc['prefix']
    assert f'{prefix}.access' in props
    # every declared gate flag (<prefix>.allow*) is rendered in the form, else operators can't enable it
    for name in doc['fields']:
        if name.startswith(f'{prefix}.allow'):
            assert name in props, f'{name} declared but not in shape properties'
    # subpackage exists with the four required modules
    pkg = ROOT / path.name.removeprefix('services.').removesuffix('.json')
    for f in ('__init__.py', 'client.py', 'IGlobal.py', 'IInstance.py'):
        assert (pkg / f).exists(), f'{pkg.name}/{f} missing'
