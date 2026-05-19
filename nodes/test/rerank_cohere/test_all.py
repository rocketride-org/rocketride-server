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
Unit tests for the Cohere Rerank pipeline node.

Only the external cohere SDK is mocked. ``rocketlib``, ``ai.*`` and
``depends`` are provided by the build interpreter (per the project
convention for ``nodes/test/<node>/test_all.py``).
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
import types
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from unittest.mock import Mock, patch

import pytest


# ---------------------------------------------------------------------------
# Module loading helpers
# ---------------------------------------------------------------------------

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parents[2]
_MOCKS_DIR = _ROOT / 'nodes' / 'test' / 'mocks'
_RERANK_DIR = _ROOT / 'nodes' / 'src' / 'nodes' / 'rerank_cohere'


@contextmanager
def _cohere_mock_on_path() -> Iterator[None]:
    """Make the project's canonical cohere mock importable as ``cohere``.

    Adds ``nodes/test/mocks`` to ``sys.path`` and clears any previously
    imported ``cohere`` modules so the mock package is loaded instead of
    a real install. Original ``sys.modules`` entries are restored on exit
    to avoid cross-test pollution.
    """
    saved_path = list(sys.path)
    saved_modules = {name: sys.modules.get(name) for name in ('cohere', 'cohere.errors')}
    for name in ('cohere', 'cohere.errors'):
        sys.modules.pop(name, None)
    sys.path.insert(0, str(_MOCKS_DIR))
    try:
        yield
    finally:
        sys.path[:] = saved_path
        for name, mod in saved_modules.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


def _load_rerank_module(module_filename: str, fq_name: str) -> types.ModuleType:
    """Load a single file from the rerank_cohere package by absolute path.

    Uses importlib so the loaded module is keyed under a unique name
    (no package import) and the test does not require ``nodes.src`` to
    be on ``sys.path``. Reuses an existing entry when present so all
    helpers share a single ``RerankClient`` class.
    """
    if fq_name in sys.modules:
        return sys.modules[fq_name]
    spec = importlib.util.spec_from_file_location(fq_name, _RERANK_DIR / module_filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[fq_name] = module
    spec.loader.exec_module(module)
    return module


# Load the rerank_client module once under the cohere mock.
with _cohere_mock_on_path():
    _rerank_client_mod = _load_rerank_module('rerank_client.py', '_rerank_cohere_test.rerank_client')

RerankClient = _rerank_client_mod.RerankClient
RerankError = _rerank_client_mod.RerankError
RerankAuthenticationError = _rerank_client_mod.RerankAuthenticationError
RerankRateLimitError = _rerank_client_mod.RerankRateLimitError
RerankBadRequestError = _rerank_client_mod.RerankBadRequestError
RerankServerError = _rerank_client_mod.RerankServerError


# ---------------------------------------------------------------------------
# Cohere mock fixtures
# ---------------------------------------------------------------------------


class _MockUnauthorizedError(Exception):
    pass


class _MockBadRequestError(Exception):
    pass


class _MockTooManyRequestsError(Exception):
    pass


class _MockInternalServerError(Exception):
    pass


def _make_mock_rerank_response(results_data):
    response = Mock()
    mock_results = []
    for data in results_data:
        r = Mock()
        r.index = data['index']
        r.relevance_score = data['relevance_score']
        mock_results.append(r)
    response.results = mock_results
    return response


def _make_cohere_client_mock(rerank_response=None):
    client = Mock()
    if rerank_response is not None:
        client.rerank.return_value = rerank_response
    return client


# ===========================================================================
# RerankClient
# ===========================================================================


class TestRerankClient:
    def _make_client(self, config=None, mock_response=None):
        config = config or {
            'model': 'rerank-english-v3.0',
            'top_n': 3,
            'min_score': 0.0,
            'apikey': 'test-api-key',
        }
        response = mock_response or _make_mock_rerank_response(
            [
                {'index': 2, 'relevance_score': 0.95},
                {'index': 0, 'relevance_score': 0.80},
                {'index': 1, 'relevance_score': 0.60},
            ]
        )
        mock_cohere_client = _make_cohere_client_mock(response)
        with patch.object(_rerank_client_mod, 'CohereClient', return_value=mock_cohere_client):
            client = RerankClient('rerank_cohere', config, {})
        client._client = mock_cohere_client
        return client

    def test_rerank_returns_ordered_results(self):
        client = self._make_client()
        documents = ['doc A', 'doc B', 'doc C']

        results = client.rerank(query='test query', documents=documents)

        assert len(results) == 3
        assert results[0]['index'] == 2
        assert results[0]['relevance_score'] == 0.95
        assert results[0]['document'] == 'doc C'
        assert results[2]['index'] == 1
        assert results[2]['document'] == 'doc B'

    def test_rerank_top_n_override(self):
        client = self._make_client()
        client.rerank(query='test', documents=['a', 'b', 'c'], top_n=2)
        client._client.rerank.assert_called_once_with(
            model='rerank-english-v3.0',
            query='test',
            documents=['a', 'b', 'c'],
            top_n=2,
        )

    def test_rerank_top_n_accepts_float_whole_number(self):
        """JSON callers may pass top_n as 5.0 -- accept and coerce to int."""
        single_response = _make_mock_rerank_response([{'index': 0, 'relevance_score': 0.9}])
        client = self._make_client(mock_response=single_response)
        client.rerank(query='q', documents=['a', 'b'], top_n=2.0)
        kwargs = client._client.rerank.call_args.kwargs
        assert kwargs['top_n'] == 2
        assert isinstance(kwargs['top_n'], int)

    def test_rerank_top_n_rejects_fractional_float(self):
        client = self._make_client()
        with pytest.raises(ValueError, match='top_n must be an integer'):
            client.rerank(query='q', documents=['a'], top_n=2.5)
        client._client.rerank.assert_not_called()

    def test_rerank_top_n_rejects_bool(self):
        """Bool is a subclass of int; must be rejected explicitly."""
        client = self._make_client()
        with pytest.raises(ValueError, match='top_n must be an integer'):
            client.rerank(query='q', documents=['a'], top_n=True)
        client._client.rerank.assert_not_called()

    def test_rerank_model_override(self):
        single_response = _make_mock_rerank_response([{'index': 0, 'relevance_score': 0.9}])
        client = self._make_client(mock_response=single_response)
        client.rerank(query='q', documents=['d'], model='rerank-v3.0')
        client._client.rerank.assert_called_once_with(
            model='rerank-v3.0',
            query='q',
            documents=['d'],
            top_n=3,
        )

    def test_rerank_empty_query_raises(self):
        client = self._make_client()
        with pytest.raises(ValueError, match='Query must not be empty'):
            client.rerank(query='', documents=['doc'])

    def test_rerank_empty_documents_raises(self):
        client = self._make_client()
        with pytest.raises(ValueError, match='Documents list must not be empty'):
            client.rerank(query='q', documents=[])

    def test_rerank_invalid_api_key(self):
        client = self._make_client()
        client._client.rerank.side_effect = _rerank_client_mod.UnauthorizedError('invalid key')
        with pytest.raises(RerankAuthenticationError, match='Invalid Cohere API key'):
            client.rerank(query='q', documents=['d'])

    def test_rerank_rate_limit(self):
        client = self._make_client()
        client._client.rerank.side_effect = _rerank_client_mod.TooManyRequestsError('rate limited')
        with pytest.raises(RerankRateLimitError, match='Cohere rate limit exceeded'):
            client.rerank(query='q', documents=['d'])

    def test_rerank_bad_request(self):
        client = self._make_client()
        client._client.rerank.side_effect = _rerank_client_mod.BadRequestError('bad request')
        with pytest.raises(RerankBadRequestError, match='Invalid rerank request'):
            client.rerank(query='q', documents=['d'])

    def test_rerank_server_error(self):
        client = self._make_client()
        client._client.rerank.side_effect = _rerank_client_mod.InternalServerError('server error')
        with pytest.raises(RerankServerError, match='Cohere server error'):
            client.rerank(query='q', documents=['d'])

    def test_rerank_with_threshold_filters_low_scores(self):
        client = self._make_client()
        results = client.rerank_with_threshold(
            query='test',
            documents=['doc A', 'doc B', 'doc C'],
            min_score=0.70,
        )
        assert len(results) == 2
        assert all(r['relevance_score'] >= 0.70 for r in results)

    def test_rerank_with_threshold_zero_returns_all(self):
        client = self._make_client()
        results = client.rerank_with_threshold(
            query='test',
            documents=['doc A', 'doc B', 'doc C'],
            min_score=0.0,
        )
        assert len(results) == 3

    def test_rerank_with_threshold_high_filters_all(self):
        client = self._make_client()
        results = client.rerank_with_threshold(
            query='test',
            documents=['doc A', 'doc B', 'doc C'],
            min_score=0.99,
        )
        assert len(results) == 0

    def test_missing_api_key_raises(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 3,
            'min_score': 0.0,
            'apikey': '',
        }
        with pytest.raises(ValueError, match='Cohere API key is required'):
            with patch.object(_rerank_client_mod, 'CohereClient'):
                RerankClient('rerank_cohere', config, {})

    def test_whitespace_api_key_raises(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 3,
            'min_score': 0.0,
            'apikey': '   ',
        }
        with pytest.raises(ValueError, match='Cohere API key is required'):
            with patch.object(_rerank_client_mod, 'CohereClient'):
                RerankClient('rerank_cohere', config, {})

    def test_api_key_is_stripped_before_client_creation(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 3,
            'min_score': 0.0,
            'apikey': ' test-api-key ',
        }
        with patch.object(_rerank_client_mod, 'CohereClient') as mock_client_cls:
            RerankClient('rerank_cohere', config, {})
        mock_client_cls.assert_called_once_with(api_key='test-api-key')

    def test_invalid_top_n_type_raises(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 'three',
            'min_score': 0.0,
            'apikey': 'test-api-key',
        }
        with pytest.raises(ValueError, match='top_n must be an integer'):
            with patch.object(_rerank_client_mod, 'CohereClient'):
                RerankClient('rerank_cohere', config, {})

    def test_invalid_top_n_fractional_float_raises(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 2.5,
            'min_score': 0.0,
            'apikey': 'test-api-key',
        }
        with pytest.raises(ValueError, match='top_n must be an integer'):
            with patch.object(_rerank_client_mod, 'CohereClient'):
                RerankClient('rerank_cohere', config, {})

    def test_top_n_accepts_json_float(self):
        """Configuring top_n as 5.0 (a JSON-style float) should succeed."""
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 5.0,
            'min_score': 0.0,
            'apikey': 'test-api-key',
        }
        with patch.object(_rerank_client_mod, 'CohereClient'):
            client = RerankClient('rerank_cohere', config, {})
        assert client._top_n == 5
        assert isinstance(client._top_n, int)

    def test_top_n_rejects_bool_at_init(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': True,
            'min_score': 0.0,
            'apikey': 'test-api-key',
        }
        with pytest.raises(ValueError, match='top_n must be an integer'):
            with patch.object(_rerank_client_mod, 'CohereClient'):
                RerankClient('rerank_cohere', config, {})

    def test_invalid_min_score_type_raises(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 3,
            'min_score': 'high',
            'apikey': 'test-api-key',
        }
        with pytest.raises(ValueError, match='min_score must be a number'):
            with patch.object(_rerank_client_mod, 'CohereClient'):
                RerankClient('rerank_cohere', config, {})

    def test_min_score_rejects_bool(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 3,
            'min_score': True,
            'apikey': 'test-api-key',
        }
        with pytest.raises(ValueError, match='min_score must be a number'):
            with patch.object(_rerank_client_mod, 'CohereClient'):
                RerankClient('rerank_cohere', config, {})

    def test_rerank_invalid_top_n_override_raises(self):
        client = self._make_client()
        with pytest.raises(ValueError, match='top_n must be an integer'):
            client.rerank(query='q', documents=['d'], top_n=0)
        client._client.rerank.assert_not_called()

    def test_rerank_with_threshold_invalid_min_score_override_raises(self):
        client = self._make_client()
        with pytest.raises(ValueError, match='min_score must be a number'):
            client.rerank_with_threshold(query='q', documents=['d'], min_score=1.5)
        client._client.rerank.assert_not_called()


# ===========================================================================
# IGlobal / IInstance — load the full package under the cohere mock
# ===========================================================================


def _load_rerank_package():
    """Import the rerank_cohere package fresh under the cohere mock.

    The package itself relies on ``rocketlib``, ``ai.common.schema`` and
    ``ai.common.config`` being importable in the runtime environment.
    Returns ``(IGlobal_module, IInstance_module)``.
    """
    package_name = '_rerank_cohere_test.pkg'
    # Drop any cached entries so we get a fresh import every time.
    for cached in [m for m in sys.modules if m.startswith(package_name)]:
        sys.modules.pop(cached, None)

    pkg_spec = importlib.util.spec_from_file_location(
        package_name,
        _RERANK_DIR / '__init__.py',
        submodule_search_locations=[str(_RERANK_DIR)],
    )
    assert pkg_spec is not None and pkg_spec.loader is not None
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[package_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)

    iglobal = importlib.import_module(f'{package_name}.IGlobal')
    iinstance = importlib.import_module(f'{package_name}.IInstance')
    return iglobal, iinstance


@pytest.fixture(scope='module')
def rerank_pkg():
    try:
        with _cohere_mock_on_path():
            yield _load_rerank_package()
    finally:
        for cached in [m for m in sys.modules if m.startswith('_rerank_cohere_test.pkg')]:
            sys.modules.pop(cached, None)


class TestIGlobal:
    def _make_iglobal(self, iglobal_mod, open_mode='CONFIG', config=None):
        from rocketlib import OPEN_MODE

        mode_value = getattr(OPEN_MODE, open_mode)
        iglobal = iglobal_mod.IGlobal()

        mock_endpoint = Mock()
        mock_endpoint.endpoint = Mock()
        mock_endpoint.endpoint.openMode = mode_value
        mock_endpoint.endpoint.bag = {}
        iglobal.IEndpoint = mock_endpoint

        mock_glb = Mock()
        mock_glb.logicalType = 'rerank_cohere'
        mock_glb.connConfig = config or {
            'profile': 'rerank-english-v3.0',
            'rerank-english-v3.0': {'apikey': 'test-key'},
        }
        iglobal.glb = mock_glb
        return iglobal

    def test_begin_global_config_mode_no_client(self, rerank_pkg):
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod, open_mode='CONFIG')
        iglobal.beginGlobal()
        assert iglobal._reranker is None

    def test_begin_global_creates_reranker(self, rerank_pkg):
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod, open_mode='SOURCE')

        mock_cohere_client = _make_cohere_client_mock(_make_mock_rerank_response([]))
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 5,
            'min_score': 0.0,
            'apikey': 'test-api-key',
        }
        with patch.object(iglobal_mod, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = config
            with patch.object(_rerank_client_mod, 'CohereClient', return_value=mock_cohere_client):
                iglobal.beginGlobal()
        assert iglobal._reranker is not None

    def test_mock_mode_skips_dependency_install(self, rerank_pkg):
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod, open_mode='SOURCE')

        # _ensure_dependencies imports ``depends`` lazily. Confirm that
        # ROCKETRIDE_MOCK short-circuits before that import even runs.
        with patch.dict(os.environ, {'ROCKETRIDE_MOCK': 'nodes/test/mocks'}, clear=False):
            # Hide depends from sys.modules so an attempted import would fail.
            saved_depends = sys.modules.pop('depends', None)
            try:
                iglobal._ensure_dependencies()  # should not raise
            finally:
                if saved_depends is not None:
                    sys.modules['depends'] = saved_depends

    def test_begin_global_invalid_config_warns_without_raising(self, rerank_pkg):
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod, open_mode='SOURCE')
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 5,
            'min_score': 0.0,
            'apikey': '',
        }
        with patch.object(iglobal_mod, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = config
            with patch.object(iglobal_mod, 'warning') as mock_warning:
                iglobal.beginGlobal()
        assert iglobal._reranker is None
        mock_warning.assert_called_once()

    def test_end_global_clears_reranker(self, rerank_pkg):
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod)
        iglobal._reranker = Mock()
        iglobal.endGlobal()
        assert iglobal._reranker is None

    def test_validate_config_missing_apikey(self, rerank_pkg):
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod)
        with patch.object(iglobal_mod, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = {'apikey': '', 'model': 'rerank-english-v3.0'}
            with patch.object(iglobal_mod, 'warning') as mock_warning:
                iglobal.validateConfig()
        mock_warning.assert_called_once()

    def test_validate_config_empty_model(self, rerank_pkg):
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod)
        with patch.object(iglobal_mod, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = {'apikey': 'test-key', 'model': '  '}
            with patch.object(iglobal_mod, 'warning') as mock_warning:
                iglobal.validateConfig()
        mock_warning.assert_called_once()

    def test_validate_config_non_string_apikey(self, rerank_pkg):
        """Non-string apikey (e.g. None) is rejected before .strip()."""
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod)
        with patch.object(iglobal_mod, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = {'apikey': None, 'model': 'rerank-english-v3.0'}
            with patch.object(iglobal_mod, 'warning') as mock_warning:
                iglobal.validateConfig()
        mock_warning.assert_called_once()

    def test_validate_config_non_string_model(self, rerank_pkg):
        """Non-string model (e.g. 42) is rejected before .strip()."""
        iglobal_mod, _ = rerank_pkg
        iglobal = self._make_iglobal(iglobal_mod)
        with patch.object(iglobal_mod, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = {'apikey': 'test-key', 'model': 42}
            with patch.object(iglobal_mod, 'warning') as mock_warning:
                iglobal.validateConfig()
        mock_warning.assert_called_once()


class TestIInstance:
    @staticmethod
    def _make_doc(page_content='', metadata=None):
        from ai.common.schema import Doc

        return Doc(page_content=page_content, metadata=metadata)

    @staticmethod
    def _make_question(query_text=None, docs=None):
        from ai.common.schema import Question

        q = Question()
        if query_text is not None:
            q.addQuestion(query_text)
        if docs:
            for d in docs:
                q.documents.append(d)
        return q

    def _make_instance(self, iinstance_mod, rerank_results=None):
        inst = iinstance_mod.IInstance()

        iglobal = Mock()
        reranker = Mock()
        if rerank_results is None:
            rerank_results = [
                {'index': 1, 'relevance_score': 0.95, 'document': 'Machine learning is a subset of AI.'},
                {'index': 0, 'relevance_score': 0.80, 'document': 'AI encompasses many fields.'},
            ]
        reranker.rerank_with_threshold.return_value = rerank_results
        iglobal._reranker = reranker
        inst.IGlobal = iglobal

        inst.instance = Mock()
        return inst

    def test_write_questions_reranks_documents(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod)

        question = self._make_question(
            'What is machine learning?',
            docs=[
                self._make_doc(page_content='AI encompasses many fields.'),
                self._make_doc(page_content='Machine learning is a subset of AI.'),
            ],
        )

        inst.writeQuestions(question)

        inst.IGlobal._reranker.rerank_with_threshold.assert_called_once()
        kwargs = inst.IGlobal._reranker.rerank_with_threshold.call_args.kwargs
        assert kwargs['query'] == 'What is machine learning?'
        assert len(kwargs['documents']) == 2

        docs = inst.instance.writeDocuments.call_args[0][0]
        assert len(docs) == 2
        assert docs[0].page_content == 'Machine learning is a subset of AI.'
        assert docs[0].score == 0.95
        assert docs[1].page_content == 'AI encompasses many fields.'
        assert docs[1].score == 0.80

    def test_write_questions_writes_answers(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod)
        question = self._make_question(
            'What is ML?',
            docs=[self._make_doc(page_content='doc1'), self._make_doc(page_content='doc2')],
        )
        inst.writeQuestions(question)
        inst.instance.writeAnswers.assert_called_once()

    def test_write_questions_no_query_raises(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod)
        question = self._make_question(docs=[self._make_doc(page_content='doc')])
        with pytest.raises(ValueError, match='No query text found'):
            inst.writeQuestions(question)

    def test_write_questions_whitespace_query_raises(self, rerank_pkg):
        """Whitespace-only query is treated as missing."""
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod)
        question = self._make_question('   ', docs=[self._make_doc(page_content='doc')])
        with pytest.raises(ValueError, match='No query text found'):
            inst.writeQuestions(question)

    def test_write_questions_no_documents_raises(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod)
        question = self._make_question('query')
        with pytest.raises(ValueError, match='No documents found'):
            inst.writeQuestions(question)

    def test_write_questions_empty_page_content_raises(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod)
        question = self._make_question('query', docs=[self._make_doc(page_content='')])
        with pytest.raises(ValueError, match='No document content found'):
            inst.writeQuestions(question)

    def test_write_questions_whitespace_page_content_raises(self, rerank_pkg):
        """Whitespace-only document content is filtered out."""
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod)
        question = self._make_question('query', docs=[self._make_doc(page_content='   ')])
        with pytest.raises(ValueError, match='No document content found'):
            inst.writeQuestions(question)

    def test_write_questions_no_reranker_raises(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod)
        inst.IGlobal._reranker = None
        question = self._make_question('query', docs=[self._make_doc(page_content='doc')])
        with pytest.raises(RuntimeError, match='Reranker not initialized'):
            inst.writeQuestions(question)

    def test_write_questions_preserves_metadata(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        rerank_results = [
            {'index': 0, 'relevance_score': 0.9, 'document': 'doc content'},
        ]
        inst = self._make_instance(iinst_mod, rerank_results=rerank_results)
        metadata = {'objectId': 'obj-123', 'chunkId': 0, 'source': 'test-file.txt'}
        question = self._make_question(
            'query',
            docs=[self._make_doc(page_content='doc content', metadata=metadata)],
        )
        inst.writeQuestions(question)
        docs = inst.instance.writeDocuments.call_args[0][0]
        assert docs[0].metadata.objectId == 'obj-123'
        assert docs[0].metadata.chunkId == 0
        assert docs[0].metadata.source == 'test-file.txt'

    def test_write_questions_metadata_alignment_after_filter(self, rerank_pkg):
        """Regression: rerank index refers to filtered list, not original."""
        _, iinst_mod = rerank_pkg
        rerank_results = [
            {'index': 1, 'relevance_score': 0.95, 'document': 'doc C content'},
        ]
        inst = self._make_instance(iinst_mod, rerank_results=rerank_results)

        meta_a = {'objectId': 'A', 'chunkId': 0}
        meta_b = {'objectId': 'B', 'chunkId': 0}
        meta_c = {'objectId': 'C', 'chunkId': 0}
        meta_d = {'objectId': 'D', 'chunkId': 0}

        question = self._make_question(
            'find C',
            docs=[
                self._make_doc(page_content='doc A content', metadata=meta_a),
                # B is dropped because page_content is empty.
                self._make_doc(page_content='', metadata=meta_b),
                self._make_doc(page_content='doc C content', metadata=meta_c),
                self._make_doc(page_content='doc D content', metadata=meta_d),
            ],
        )

        inst.writeQuestions(question)

        kwargs = inst.IGlobal._reranker.rerank_with_threshold.call_args.kwargs
        assert kwargs['documents'] == ['doc A content', 'doc C content', 'doc D content']

        docs = inst.instance.writeDocuments.call_args[0][0]
        assert len(docs) == 1
        assert docs[0].metadata.objectId == 'C'
        assert docs[0].metadata.objectId != 'B'

    def test_write_questions_empty_rerank_results(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        inst = self._make_instance(iinst_mod, rerank_results=[])
        question = self._make_question('query', docs=[self._make_doc(page_content='doc')])
        inst.writeQuestions(question)
        inst.instance.writeDocuments.assert_not_called()
        inst.instance.writeAnswers.assert_called_once()

    def test_write_questions_does_not_mutate_original(self, rerank_pkg):
        _, iinst_mod = rerank_pkg
        rerank_results = [
            {'index': 0, 'relevance_score': 0.90, 'document': 'doc A'},
        ]
        inst = self._make_instance(iinst_mod, rerank_results=rerank_results)

        original_doc = self._make_doc(
            page_content='doc A',
            metadata={'objectId': 'orig', 'chunkId': 0, 'source': 'test'},
        )
        question = self._make_question('What is AI?', docs=[original_doc])
        original_documents = list(question.documents)

        inst.writeQuestions(question)

        assert question.documents == original_documents
        assert len(question.documents) == 1
        assert question.documents[0] is original_doc


# ===========================================================================
# Exception hierarchy
# ===========================================================================


class TestRerankExceptions:
    def test_all_errors_inherit_from_rerank_error(self):
        assert issubclass(RerankAuthenticationError, RerankError)
        assert issubclass(RerankRateLimitError, RerankError)
        assert issubclass(RerankBadRequestError, RerankError)
        assert issubclass(RerankServerError, RerankError)

    def test_rerank_error_inherits_from_exception(self):
        assert issubclass(RerankError, Exception)
        assert not issubclass(RerankError, ValueError)

    def test_class_names_carry_circuit_breaker_hints(self):
        assert 'RateLimit' in RerankRateLimitError.__name__
        assert 'ServerError' in RerankServerError.__name__
        assert 'Authentication' in RerankAuthenticationError.__name__
        assert 'BadRequest' in RerankBadRequestError.__name__

    def test_exception_preserves_original_cause(self):
        config = {
            'model': 'rerank-english-v3.0',
            'top_n': 3,
            'min_score': 0.0,
            'apikey': 'test-api-key',
        }
        mock_cohere_client = _make_cohere_client_mock(_make_mock_rerank_response([]))
        with patch.object(_rerank_client_mod, 'CohereClient', return_value=mock_cohere_client):
            client = RerankClient('rerank_cohere', config, {})

        original = _rerank_client_mod.UnauthorizedError('original error')
        client._client.rerank.side_effect = original

        with pytest.raises(RerankAuthenticationError) as exc_info:
            client.rerank(query='q', documents=['d'])
        assert exc_info.value.__cause__ is original
