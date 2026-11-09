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

"""The Chroma key check follows the host type: a local server gets no key, so an unfilled one is not an error."""

from types import SimpleNamespace

import pytest

from ai.common.config import UnresolvedCredentialError
from nodes.store_chroma.IGlobal import IGlobal

PLACEHOLDER = '${ROCKETRIDE_CHROMA_KEY}'


@pytest.fixture
def glb():
    """The node's IGlobal, without the engine's endpoint plumbing."""
    instance = IGlobal.__new__(IGlobal)
    instance.glb = SimpleNamespace(logicalType='chroma')
    return instance


def test_a_local_server_does_not_check_the_key(glb):
    """The local branch has no key at all; nothing is checked."""
    glb._check_credentials({'profile': 'local', 'host': 'localhost'})


def test_a_cloud_server_checks_the_key(glb):
    """The key goes to the server, so an unfilled one names the missing variable."""
    with pytest.raises(UnresolvedCredentialError, match='no variable named ROCKETRIDE_CHROMA_KEY was found'):
        glb._check_credentials({'profile': 'cloud', 'apikey': PLACEHOLDER})


def test_a_cloud_server_with_a_filled_key_passes(glb):
    glb._check_credentials({'profile': 'cloud', 'apikey': 'a-real-token'})
