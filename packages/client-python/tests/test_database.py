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
Unit tests for DatabaseApi transaction methods and the extended query signature.

Uses an async fake client that records all kwargs passed to its ``tool`` method
so we can assert exact wire payloads without a live server connection.
"""

import pytest

from rocketride.database import DatabaseApi


# =========================================================================
# FAKE CLIENT
# =========================================================================


class FakeClient:
    """Async fake whose ``tool`` method records the kwargs it receives."""

    def __init__(self, return_value=None):
        self.calls = []
        self._return_value = return_value or {}

    async def tool(self, **kwargs):
        """Record kwargs and return a configurable stub value."""
        self.calls.append(kwargs)
        return self._return_value

    @property
    def last_call(self):
        """Return the most recent recorded call kwargs."""
        return self.calls[-1]


# =========================================================================
# HELPERS
# =========================================================================

TOKEN = 'tk_test_token'
SESSION_ID = 'sess_abc123'


def make_api(return_value=None):
    """Create a DatabaseApi backed by a FakeClient."""
    fake = FakeClient(return_value=return_value)
    api = DatabaseApi(fake)
    return api, fake


# =========================================================================
# begin_transaction
# =========================================================================


class TestBeginTransaction:
    """Tests for DatabaseApi.begin_transaction."""

    @pytest.mark.asyncio
    async def test_invokes_begin_tool(self):
        """begin_transaction sends tool='begin' with an empty input dict."""
        api, fake = make_api(return_value={'session_id': SESSION_ID})
        await api.begin_transaction(token=TOKEN)
        assert fake.last_call['tool'] == 'begin'
        assert fake.last_call['input'] == {}

    @pytest.mark.asyncio
    async def test_passes_token(self):
        """begin_transaction passes the token to the underlying tool call."""
        api, fake = make_api()
        await api.begin_transaction(token=TOKEN)
        assert fake.last_call['token'] == TOKEN

    @pytest.mark.asyncio
    async def test_passes_node_id_when_given(self):
        """begin_transaction forwards node_id when supplied."""
        api, fake = make_api()
        await api.begin_transaction(token=TOKEN, node_id='db_node_1')
        assert fake.last_call['node_id'] == 'db_node_1'

    @pytest.mark.asyncio
    async def test_default_node_id_is_empty(self):
        """begin_transaction defaults node_id to empty string."""
        api, fake = make_api()
        await api.begin_transaction(token=TOKEN)
        assert fake.last_call['node_id'] == ''

    @pytest.mark.asyncio
    async def test_empty_token_raises_value_error(self):
        """begin_transaction raises ValueError when token is empty."""
        api, _ = make_api()
        with pytest.raises(ValueError, match='token'):
            await api.begin_transaction(token='')

    @pytest.mark.asyncio
    async def test_whitespace_token_raises_value_error(self):
        """begin_transaction raises ValueError when token is whitespace-only."""
        api, _ = make_api()
        with pytest.raises(ValueError, match='token'):
            await api.begin_transaction(token='   ')


# =========================================================================
# commit
# =========================================================================


class TestCommit:
    """Tests for DatabaseApi.commit."""

    @pytest.mark.asyncio
    async def test_invokes_commit_tool(self):
        """Commit sends tool='commit' with session_id in input."""
        api, fake = make_api(return_value={'ok': True})
        await api.commit(token=TOKEN, session_id=SESSION_ID)
        assert fake.last_call['tool'] == 'commit'
        assert fake.last_call['input'] == {'session_id': SESSION_ID}

    @pytest.mark.asyncio
    async def test_passes_token(self):
        """Commit passes the token to the underlying tool call."""
        api, fake = make_api()
        await api.commit(token=TOKEN, session_id=SESSION_ID)
        assert fake.last_call['token'] == TOKEN

    @pytest.mark.asyncio
    async def test_passes_node_id_when_given(self):
        """Commit forwards node_id when supplied."""
        api, fake = make_api()
        await api.commit(token=TOKEN, session_id=SESSION_ID, node_id='db_node_1')
        assert fake.last_call['node_id'] == 'db_node_1'

    @pytest.mark.asyncio
    async def test_default_node_id_is_empty(self):
        """Commit defaults node_id to empty string."""
        api, fake = make_api()
        await api.commit(token=TOKEN, session_id=SESSION_ID)
        assert fake.last_call['node_id'] == ''

    @pytest.mark.asyncio
    async def test_empty_token_raises_value_error(self):
        """Commit raises ValueError when token is empty."""
        api, _ = make_api()
        with pytest.raises(ValueError, match='token'):
            await api.commit(token='', session_id=SESSION_ID)

    @pytest.mark.asyncio
    async def test_empty_session_id_raises_value_error(self):
        """Commit raises ValueError when session_id is empty."""
        api, _ = make_api()
        with pytest.raises(ValueError, match='session_id'):
            await api.commit(token=TOKEN, session_id='')


# =========================================================================
# rollback
# =========================================================================


class TestRollback:
    """Tests for DatabaseApi.rollback."""

    @pytest.mark.asyncio
    async def test_invokes_rollback_tool(self):
        """Rollback sends tool='rollback' with session_id in input."""
        api, fake = make_api(return_value={'ok': True})
        await api.rollback(token=TOKEN, session_id=SESSION_ID)
        assert fake.last_call['tool'] == 'rollback'
        assert fake.last_call['input'] == {'session_id': SESSION_ID}

    @pytest.mark.asyncio
    async def test_passes_token(self):
        """Rollback passes the token to the underlying tool call."""
        api, fake = make_api()
        await api.rollback(token=TOKEN, session_id=SESSION_ID)
        assert fake.last_call['token'] == TOKEN

    @pytest.mark.asyncio
    async def test_passes_node_id_when_given(self):
        """Rollback forwards node_id when supplied."""
        api, fake = make_api()
        await api.rollback(token=TOKEN, session_id=SESSION_ID, node_id='db_node_1')
        assert fake.last_call['node_id'] == 'db_node_1'

    @pytest.mark.asyncio
    async def test_default_node_id_is_empty(self):
        """Rollback defaults node_id to empty string."""
        api, fake = make_api()
        await api.rollback(token=TOKEN, session_id=SESSION_ID)
        assert fake.last_call['node_id'] == ''

    @pytest.mark.asyncio
    async def test_empty_token_raises_value_error(self):
        """Rollback raises ValueError when token is empty."""
        api, _ = make_api()
        with pytest.raises(ValueError, match='token'):
            await api.rollback(token='', session_id=SESSION_ID)

    @pytest.mark.asyncio
    async def test_empty_session_id_raises_value_error(self):
        """Rollback raises ValueError when session_id is empty."""
        api, _ = make_api()
        with pytest.raises(ValueError, match='session_id'):
            await api.rollback(token=TOKEN, session_id='')


# =========================================================================
# query — extended signature
# =========================================================================


class TestQueryExtended:
    """Tests for the extended DatabaseApi.query with session_id and params."""

    @pytest.mark.asyncio
    async def test_plain_query_sends_only_sql_in_input(self):
        """Query without session_id/params sends input={'sql': ...} with no extra keys."""
        api, fake = make_api()
        await api.query(token=TOKEN, sql='SELECT 1')
        assert fake.last_call['input'] == {'sql': 'SELECT 1'}

    @pytest.mark.asyncio
    async def test_query_with_session_id_includes_it(self):
        """Query with session_id adds session_id to the input dict."""
        api, fake = make_api()
        await api.query(token=TOKEN, sql='SELECT 1', session_id=SESSION_ID)
        assert fake.last_call['input'] == {'sql': 'SELECT 1', 'session_id': SESSION_ID}

    @pytest.mark.asyncio
    async def test_query_with_params_includes_them(self):
        """Query with params adds params to the input dict."""
        api, fake = make_api()
        await api.query(token=TOKEN, sql='SELECT $1', params=[42])
        assert fake.last_call['input'] == {'sql': 'SELECT $1', 'params': [42]}

    @pytest.mark.asyncio
    async def test_query_with_session_id_and_params(self):
        """Query with both session_id and params includes both in input."""
        api, fake = make_api()
        await api.query(token=TOKEN, sql='SELECT $1', session_id=SESSION_ID, params=[1, 'foo'])
        assert fake.last_call['input'] == {
            'sql': 'SELECT $1',
            'session_id': SESSION_ID,
            'params': [1, 'foo'],
        }

    @pytest.mark.asyncio
    async def test_empty_session_id_not_included_in_input(self):
        """Query with session_id='' (falsy) does not add session_id to input."""
        api, fake = make_api()
        await api.query(token=TOKEN, sql='SELECT 1', session_id='')
        assert 'session_id' not in fake.last_call['input']

    @pytest.mark.asyncio
    async def test_none_params_not_included_in_input(self):
        """Query with params=None (falsy) does not add params to input."""
        api, fake = make_api()
        await api.query(token=TOKEN, sql='SELECT 1', params=None)
        assert 'params' not in fake.last_call['input']
