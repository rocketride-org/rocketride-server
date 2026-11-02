# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Chroma sends its key to a cloud or remote server only, so only then is an unfilled key an error.

The running store reads the profile from ``mode`` or, for a direct configuration,
``profile``, and treats anything else as local. A local server gets no key, so a key
left as an unfilled ${ROCKETRIDE_...} must not stop a local pipeline.
"""

import importlib.util
import os
from types import SimpleNamespace

import pytest

from ai.common.config import UnresolvedCredentialError

_MOD_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'store_chroma', 'IGlobal.py'
)
PLACEHOLDER = '${ROCKETRIDE_CHROMA_KEY}'


@pytest.fixture
def glb():
    """The node's IGlobal, without the engine's endpoint plumbing."""
    spec = importlib.util.spec_from_file_location('_store_chroma_iglobal_credentials', _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    instance = mod.IGlobal.__new__(mod.IGlobal)
    instance.glb = SimpleNamespace(logicalType='chroma')
    return instance


@pytest.mark.parametrize(
    'config',
    [{'mode': 'local'}, {'profile': 'local'}, {}],
    ids=['local-by-mode', 'local-by-profile', 'no-profile-means-local'],
)
def test_a_local_server_does_not_check_the_key(glb, config):
    """A key the local server never gets cannot stop the pipeline."""
    glb._check_credentials({**config, 'apikey': PLACEHOLDER}, None)


@pytest.mark.parametrize('config', [{'mode': 'cloud'}, {'profile': 'cloud'}], ids=['cloud-by-mode', 'cloud-by-profile'])
def test_a_cloud_server_checks_the_key(glb, config):
    """The key goes to the server, so an unfilled one names the missing variable."""
    with pytest.raises(UnresolvedCredentialError, match='no variable named ROCKETRIDE_CHROMA_KEY was found'):
        glb._check_credentials({**config, 'apikey': PLACEHOLDER}, None)


def test_a_cloud_server_with_a_filled_key_passes(glb):
    glb._check_credentials({'mode': 'cloud', 'apikey': 'a-real-token'}, None)
