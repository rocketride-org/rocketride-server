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

"""
The server's own settings are RR_* names; a retired ROCKETRIDE_* spelling refuses the start.

A retired spelling would be a value every pipeline can reference and every
engine inherits, and the server would ignore it, so ``check_server_environment``
names it and its replacement instead of reading it.
"""

import pytest

from ai.common.server_env import RENAMED_SETTINGS, check_server_environment, mocks_path

# ==== The startup check ==========================================================


def test_an_environment_with_only_current_names_starts():
    environ = {new: 'value' for new in RENAMED_SETTINGS.values()}
    environ.update({'ROCKETRIDE_OPENAI_KEY': 'sk-pipeline', 'ROCKETRIDE_URI': 'ws://localhost:5565'})
    check_server_environment(environ)


@pytest.mark.parametrize('old, new', sorted(RENAMED_SETTINGS.items()))
def test_a_renamed_setting_under_its_old_name_refuses_the_start(old, new):
    with pytest.raises(EnvironmentError, match=f'{old} has been renamed to {new}'):
        check_server_environment({old: 'value'})


@pytest.mark.parametrize('old, new', sorted(RENAMED_SETTINGS.items()))
def test_the_old_name_refuses_even_beside_the_new_one(old, new):
    # It would still reach every pipeline and engine under the old name
    with pytest.raises(EnvironmentError, match=old):
        check_server_environment({old: 'stale', new: 'current'})


def test_one_error_names_every_retired_variable():
    environ = {old: 'x' for old in RENAMED_SETTINGS}
    with pytest.raises(EnvironmentError) as raised:
        check_server_environment(environ)
    for old in environ:
        assert old in str(raised.value)


def test_an_empty_retired_name_is_not_a_setting():
    check_server_environment({old: '' for old in RENAMED_SETTINGS})


def test_the_server_turns_the_refusal_into_its_exit():
    from ai import eaas

    with pytest.raises(SystemExit, match='ROCKETRIDE_MOCK has been renamed to RR_MOCK'):
        with pytest.MonkeyPatch.context() as patch:
            patch.setenv('ROCKETRIDE_MOCK', 'nodes/test/mocks')
            eaas._require_current_settings()


# ==== RR_MOCK =================================================================


def test_mocks_are_read_from_rr_mock_only():
    assert mocks_path({'RR_MOCK': 'nodes/test/mocks'}) == 'nodes/test/mocks'
    assert mocks_path({'ROCKETRIDE_MOCK': 'nodes/test/mocks'}) == ''
    assert mocks_path({}) == ''
