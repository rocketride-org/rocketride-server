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

"""The Google Cloud Storage validator reports a bad service-account key at save time.

The engine imports IValidator alone in CONFIG mode; its semantic check is the
shared GCP credential build. A key that is missing or does not parse must come
back as a warning while the user is still editing, not at pipeline start.
"""

import importlib.util
import os
import sys

import pytest

import nodes.core.gcp_auth as gcp_auth

_PKG = 'tool_gcs'
_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only'
_NODE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', _PKG)


def _load_validator():
    spec = importlib.util.spec_from_file_location(f'_{_PKG}_validator', os.path.join(_NODE_DIR, 'IValidator.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def validator(monkeypatch):
    """An IValidator whose resolved config is a plain dict and whose warnings are captured."""
    module = _load_validator()
    warnings = []
    monkeypatch.setattr(module, 'warning', warnings.append)
    config = {'authType': 'service_account', 'serviceAccountKey': 'not json', 'projectId': ''}
    monkeypatch.setattr(module.IValidator, 'config', property(lambda self: config), raising=False)
    return module.IValidator(), warnings


def test_validator_is_import_light():
    """Loading the validator pulls in neither the node's IGlobal nor the GCP SDK."""
    before = set(sys.modules)
    _load_validator()
    added = set(sys.modules) - before
    assert not any(name == 'google' or name.startswith(('google.', f'nodes.{_PKG}.IGlobal')) for name in added)


def test_malformed_service_account_key_is_a_warning(validator):
    instance, warnings = validator
    instance.validateConfig()
    assert len(warnings) == 1
    assert warnings[0].startswith('Auth configuration error: Failed to parse Service Account JSON key')


def test_missing_service_account_key_is_a_warning(validator, monkeypatch):
    instance, warnings = validator
    monkeypatch.setattr(
        type(instance), 'config', property(lambda self: {'authType': 'service_account', 'serviceAccountKey': ''})
    )
    instance.validateConfig()
    assert warnings == [
        'Auth configuration error: Service Account JSON key is required when authType is '
        "'service_account', but missing."
    ]


def test_credentials_are_built_with_the_node_scopes(validator, monkeypatch):
    instance, warnings = validator
    seen = {}

    def fake(config, scopes=None):
        seen['scopes'] = scopes
        return object(), 'proj'

    monkeypatch.setattr(gcp_auth, 'get_gcp_credentials', fake)
    instance.validateConfig()
    assert warnings == []
    assert seen['scopes'] == [_SCOPE]


def test_a_missing_google_auth_is_reported_not_mistaken_for_a_bad_key(validator, monkeypatch):
    # CONFIG mode installs no node requirements: an absent google-auth is a
    # skipped check, not a credential problem
    instance, warnings = validator
    import importlib.util

    real_find_spec = importlib.util.find_spec
    monkeypatch.setattr(
        importlib.util,
        'find_spec',
        lambda name, *a, **k: None if name == 'google.auth' else real_find_spec(name, *a, **k),
    )

    def boom(*args, **kwargs):
        raise AssertionError('the helper must not run without google-auth')

    monkeypatch.setattr(gcp_auth, 'get_gcp_credentials', boom)
    instance.validateConfig()
    assert len(warnings) == 1 and warnings[0].startswith('Credential check skipped: google-auth is not installed')


def test_a_missing_google_parent_package_is_also_a_skipped_check(validator, monkeypatch):
    # With no `google` package at all, find_spec raises instead of returning None
    instance, warnings = validator
    import importlib.util

    def raise_missing(name, *a, **k):
        raise ModuleNotFoundError("No module named 'google'")

    monkeypatch.setattr(importlib.util, 'find_spec', raise_missing)
    monkeypatch.setattr(
        gcp_auth, 'get_gcp_credentials', lambda *a, **k: (_ for _ in ()).throw(AssertionError('must not run'))
    )
    instance.validateConfig()
    assert len(warnings) == 1 and warnings[0].startswith('Credential check skipped: google-auth is not installed')


def test_syntax_only_skips_the_credential_build(validator, monkeypatch):
    instance, warnings = validator

    def boom(*args, **kwargs):
        raise AssertionError('must not build credentials in syntaxOnly')

    monkeypatch.setattr(gcp_auth, 'get_gcp_credentials', boom)
    instance.validateConfig(syntaxOnly=True)
    assert warnings == []
