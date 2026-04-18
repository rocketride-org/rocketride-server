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

All tests use mocks -- no external API calls are made.

Usage:
    pytest test/nodes/test_rerank_cohere.py -v
"""

import sys
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: mock engine-level modules before importing node code
# ---------------------------------------------------------------------------

NODES_SRC = Path(__file__).parent.parent.parent / 'nodes' / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))


class _MockIGlobalBase:
    IEndpoint = None
    glb = None

    def beginGlobal(self):
        pass

    def endGlobal(self):
        pass

    def preventDefault(self):
        raise Exception('PreventDefault')


class _MockIInstanceBase:
    IGlobal = None
    IEndpoint = None
    instance = None

    def beginInstance(self):
        pass

    def endInstance(self):
        pass

    def preventDefault(self):
        raise Exception('PreventDefault')


class _MockOPEN_MODE:
    CONFIG = 'CONFIG'
    SOURCE = 'SOURCE'
    TARGET = 'TARGET'


class _MockEntry:
    def __init__(self, **kwargs):
        self.url = kwargs.get('url', 'test://file.txt')
        self.path = kwargs.get('path', '/test/file.txt')
        self.objectId = kwargs.get('objectId', 'test-obj-123')


class _MockDoc:
    """Lightweight Doc stand-in."""

    def __init__(self, page_content='', metadata=None, score=0.0, **kwargs):
        self.page_content = page_content
        self.metadata = metadata
        self.score = score
        self.type = 'Document'
        self.embedding_model = kwargs.get('embedding_model')
        self.embedding = kwargs.get('embedding')
        self.context = kwargs.get('context')
        self.tokens = kwargs.get('tokens')
        self.highlight_score = kwargs.get('highlight_score')

    def toDict(self):
        return {'page_content': self.page_content, 'score': self.score, 'metadata': self.metadata}


class _MockQuestionText:
    def __init__(self, text='', embedding_model=None, embedding=None):
        self.text = text
        self.embedding_model = embedding_model
        self.embedding = embedding


class _MockQuestion:
    def __init__(self):
        self.questions = []
        self.documents = []
        self.context = []
        self.type = 'question'
        self.filter = None
        self.expectJson = False
        self.role = ''
        self.instructions = []
        self.history = []
        self.examples = []
        self.goals = []

    def addQuestion(self, text):
        self.questions.append(_MockQuestionText(text=text))

    def addDocuments(self, docs):
        if not isinstance(docs, list):
            docs = [docs]
        self.documents.extend(docs)


# Install mocks before any node imports
_mock_rocketlib = MagicMock()
_mock_rocketlib.IGlobalBase = _MockIGlobalBase
_mock_rocketlib.IInstanceBase = _MockIInstanceBase
_mock_rocketlib.OPEN_MODE = _MockOPEN_MODE
_mock_rocketlib.Entry = _MockEntry
_mock_rocketlib.warning = Mock()
_mock_rocketlib.APERR = Mock(side_effect=Exception)
_mock_rocketlib.Ec = MagicMock()
_mock_rocketlib.Ec.PreventDefault = 'PreventDefault'
_mock_rocketlib.getServiceDefinition = Mock(return_value=None)

_mock_ai_schema = MagicMock()
_mock_ai_schema.Doc = _MockDoc
_mock_ai_schema.Question = _MockQuestion

_mock_ai_config = MagicMock()
_mock_ai_common = MagicMock()
_mock_ai_common.schema = _mock_ai_schema
_mock_ai_common.config = _mock_ai_config

_mock_ai = MagicMock()
_mock_ai.common = _mock_ai_common
_mock_ai.common.schema = _mock_ai_schema
_mock_ai.common.config = _mock_ai_config

_mock_depends = MagicMock()
_mock_depends.depends = Mock()

# Cohere mock
_mock_cohere = MagicMock()
_mock_cohere_errors = MagicMock()


class _MockUnauthorizedError(Exception):
    pass


class _MockBadRequestError(Exception):
    pass


class _MockTooManyRequestsError(Exception):
    pass


class _MockInternalServerError(Exception):
    pass


_mock_cohere_errors.UnauthorizedError = _MockUnauthorizedError
_mock_cohere_errors.BadRequestError = _MockBadRequestError
_mock_cohere_errors.TooManyRequestsError = _MockTooManyRequestsError
_mock_cohere_errors.InternalServerError = _MockInternalServerError

sys.modules['rocketlib'] = _mock_rocketlib
sys.modules['ai'] = _mock_ai
sys.modules['ai.common'] = _mock_ai_common
sys.modules['ai.common.schema'] = _mock_ai_schema
sys.modules['ai.common.config'] = _mock_ai_config
sys.modules['depends'] = _mock_depends
sys.modules['cohere'] = _mock_cohere
sys.modules['cohere.errors'] = _mock_cohere_errors

# Patch cohere error classes into the cohere mock module
_mock_cohere.errors = _mock_cohere_errors

# Now import the node code
from rerank_cohere.rerank_client import RerankClient, RerankError, RerankAuthenticationError, RerankRateLimitError, RerankBadRequestError, RerankServerError  # noqa: E402
from rerank_cohere.IGlobal import IGlobal  # noqa: E402
from rerank_cohere.IInstance import IInstance  # noqa: E402

# Keep a reference to the IGlobal *module* (not the class) so patch.object
# can target the module-level ``Config`` name that the class shadows in
# ``rerank_cohere.__init__``.
_iglobal_module = sys.modules['rerank_cohere.IGlobal']


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_rerank_response(results_data):
    """Build a mock Cohere rerank response object."""
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
    """Create a mock CohereClient that returns the given rerank response."""
    client = Mock()
    if rerank_response is not None:
        client.rerank.return_value = rerank_response
    return client


# ===========================================================================
# RerankClient Tests
# ===========================================================================


class TestRerankClient:
    """Tests for the RerankClient wrapper."""

    def _make_client(self, config=None, mock_response=None):
        """Create a RerankClient with a mocked Cohere backend."""
        config = config or {
            'model': 'rerank-v3.5',
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

        with patch('rerank_cohere.rerank_client.CohereClient', return_value=mock_cohere_client):
            client = RerankClient('rerank_cohere', config, {})

        # Replace the internal client with our mock
        client._client = mock_cohere_client
        return client

    def test_rerank_returns_ordered_results(self):
        """rerank() returns results with index, relevance_score, and document text."""
        client = self._make_client()
        documents = ['doc A', 'doc B', 'doc C']

        results = client.rerank(query='test query', documents=documents)

        assert len(results) == 3
        assert results[0]['index'] == 2
        assert results[0]['relevance_score'] == 0.95
        assert results[0]['document'] == 'doc C'
        assert results[1]['index'] == 0
        assert results[1]['relevance_score'] == 0.80
        assert results[1]['document'] == 'doc A'
        assert results[2]['index'] == 1
        assert results[2]['relevance_score'] == 0.60
        assert results[2]['document'] == 'doc B'

    def test_rerank_top_n_override(self):
        """top_n parameter is forwarded to the Cohere API call."""
        client = self._make_client()

        client.rerank(query='test', documents=['a', 'b', 'c'], top_n=2)

        client._client.rerank.assert_called_once_with(
            model='rerank-v3.5',
            query='test',
            documents=['a', 'b', 'c'],
            top_n=2,
        )

    def test_rerank_model_override(self):
        """Model parameter overrides the configured default."""
        single_response = _make_mock_rerank_response(
            [
                {'index': 0, 'relevance_score': 0.9},
            ]
        )
        client = self._make_client(mock_response=single_response)

        client.rerank(query='q', documents=['d'], model='rerank-v3.0')

        client._client.rerank.assert_called_once_with(
            model='rerank-v3.0',
            query='q',
            documents=['d'],
            top_n=3,
        )

    def test_rerank_empty_query_raises(self):
        """Empty query raises ValueError."""
        client = self._make_client()

        with pytest.raises(ValueError, match='Query must not be empty'):
            client.rerank(query='', documents=['doc'])

    def test_rerank_empty_documents_raises(self):
        """Empty documents list raises ValueError."""
        client = self._make_client()

        with pytest.raises(ValueError, match='Documents list must not be empty'):
            client.rerank(query='q', documents=[])

    def test_rerank_invalid_api_key(self):
        """UnauthorizedError from Cohere is raised as RerankAuthenticationError."""
        client = self._make_client()
        client._client.rerank.side_effect = _MockUnauthorizedError('invalid key')

        with pytest.raises(RerankAuthenticationError, match='Invalid Cohere API key'):
            client.rerank(query='q', documents=['d'])

    def test_rerank_rate_limit(self):
        """TooManyRequestsError is raised as RerankRateLimitError."""
        client = self._make_client()
        client._client.rerank.side_effect = _MockTooManyRequestsError('rate limited')

        with pytest.raises(RerankRateLimitError, match='Cohere rate limit exceeded'):
            client.rerank(query='q', documents=['d'])

    def test_rerank_bad_request(self):
        """BadRequestError is raised as RerankBadRequestError."""
        client = self._make_client()
        client._client.rerank.side_effect = _MockBadRequestError('bad request')

        with pytest.raises(RerankBadRequestError, match='Invalid rerank request'):
            client.rerank(query='q', documents=['d'])

    def test_rerank_server_error(self):
        """InternalServerError is raised as RerankServerError."""
        client = self._make_client()
        client._client.rerank.side_effect = _MockInternalServerError('server error')

        with pytest.raises(RerankServerError, match='Cohere server error'):
            client.rerank(query='q', documents=['d'])

    def test_rerank_with_threshold_filters_low_scores(self):
        """rerank_with_threshold() filters out results below min_score."""
        client = self._make_client()
        documents = ['doc A', 'doc B', 'doc C']

        results = client.rerank_with_threshold(
            query='test',
            documents=documents,
            min_score=0.70,
        )

        # Only results with score >= 0.70 should remain
        assert len(results) == 2
        assert all(r['relevance_score'] >= 0.70 for r in results)

    def test_rerank_with_threshold_zero_returns_all(self):
        """min_score=0.0 means no filtering."""
        client = self._make_client()
        documents = ['doc A', 'doc B', 'doc C']

        results = client.rerank_with_threshold(
            query='test',
            documents=documents,
            min_score=0.0,
        )

        assert len(results) == 3

    def test_rerank_with_threshold_high_filters_all(self):
        """A very high min_score filters out all results."""
        client = self._make_client()
        documents = ['doc A', 'doc B', 'doc C']

        results = client.rerank_with_threshold(
            query='test',
            documents=documents,
            min_score=0.99,
        )

        # Only the 0.95 result should be filtered out too
        assert len(results) == 0

    def test_missing_api_key_raises(self):
        """RerankClient raises ValueError when apikey is empty."""
        config = {
            'model': 'rerank-v3.5',
            'top_n': 3,
            'min_score': 0.0,
            'apikey': '',
        }
        with pytest.raises(ValueError, match='Cohere API key is required'):
            with patch('rerank_cohere.rerank_client.CohereClient'):
                RerankClient('rerank_cohere', config, {})


# ===========================================================================
# IGlobal Tests
# ===========================================================================


class TestIGlobal:
    """Tests for the Cohere Rerank IGlobal class."""

    def _make_iglobal(self, open_mode='CONFIG', config=None):
        """Create an IGlobal instance with mocked engine context."""
        iglobal = IGlobal()

        mock_endpoint = Mock()
        mock_endpoint.endpoint = Mock()
        mock_endpoint.endpoint.openMode = open_mode
        mock_endpoint.endpoint.bag = {}
        iglobal.IEndpoint = mock_endpoint

        mock_glb = Mock()
        mock_glb.logicalType = 'rerank_cohere'
        mock_glb.connConfig = config or {'profile': 'rerank-v3.5', 'rerank-v3.5': {'apikey': 'test-key'}}
        iglobal.glb = mock_glb

        return iglobal

    def test_begin_global_config_mode_no_client(self):
        """In CONFIG mode, beginGlobal does not create a reranker."""
        iglobal = self._make_iglobal(open_mode='CONFIG')
        iglobal.beginGlobal()

        assert iglobal._reranker is None

    def test_begin_global_creates_reranker(self):
        """In non-CONFIG mode, beginGlobal creates a RerankClient."""
        iglobal = self._make_iglobal(open_mode='TARGET')

        mock_response = _make_mock_rerank_response([])
        mock_cohere_client = _make_cohere_client_mock(mock_response)

        # Mock Config.getNodeConfig to return our test config
        with patch.object(_iglobal_module, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = {
                'model': 'rerank-v3.5',
                'top_n': 5,
                'min_score': 0.0,
                'apikey': 'test-api-key',
            }
            with patch('rerank_cohere.rerank_client.CohereClient', return_value=mock_cohere_client):
                iglobal.beginGlobal()

        assert iglobal._reranker is not None

    def test_end_global_clears_reranker(self):
        """EndGlobal sets _reranker to None."""
        iglobal = self._make_iglobal()
        iglobal._reranker = Mock()
        iglobal.endGlobal()

        assert iglobal._reranker is None

    def test_validate_config_missing_apikey(self):
        """ValidateConfig warns when API key is missing."""
        iglobal = self._make_iglobal()
        _mock_rocketlib.warning.reset_mock()

        with patch.object(_iglobal_module, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = {'apikey': '', 'model': 'rerank-v3.5'}
            iglobal.validateConfig()

        _mock_rocketlib.warning.assert_called_once()

    def test_validate_config_empty_model(self):
        """ValidateConfig warns when model name is empty."""
        iglobal = self._make_iglobal()
        _mock_rocketlib.warning.reset_mock()

        with patch.object(_iglobal_module, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.return_value = {'apikey': 'test-key', 'model': '  '}
            iglobal.validateConfig()

        _mock_rocketlib.warning.assert_called_once()


# ===========================================================================
# IInstance Tests
# ===========================================================================


class TestIInstance:
    """Tests for the Cohere Rerank IInstance class."""

    def _make_instance(self, rerank_results=None):
        """Create an IInstance with a mocked IGlobal and reranker."""
        inst = IInstance()

        # Mock IGlobal with a reranker
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

        # Mock the instance (output capture)
        mock_instance = Mock()
        inst.instance = mock_instance

        return inst

    def test_write_questions_reranks_documents(self):
        """WriteQuestions calls reranker and writes reranked documents."""
        inst = self._make_instance()

        question = _MockQuestion()
        question.addQuestion('What is machine learning?')
        question.addDocuments(_MockDoc(page_content='AI encompasses many fields.'))
        question.addDocuments(_MockDoc(page_content='Machine learning is a subset of AI.'))

        inst.writeQuestions(question)

        # Verify reranker was called
        inst.IGlobal._reranker.rerank_with_threshold.assert_called_once()
        call_kwargs = inst.IGlobal._reranker.rerank_with_threshold.call_args
        assert call_kwargs.kwargs['query'] == 'What is machine learning?'
        assert len(call_kwargs.kwargs['documents']) == 2

        # Verify documents were written
        inst.instance.writeDocuments.assert_called_once()
        docs = inst.instance.writeDocuments.call_args[0][0]
        assert len(docs) == 2
        assert docs[0].page_content == 'Machine learning is a subset of AI.'
        assert docs[0].score == 0.95
        assert docs[1].page_content == 'AI encompasses many fields.'
        assert docs[1].score == 0.80

    def test_write_questions_writes_answers(self):
        """WriteQuestions also writes answers with reranked documents."""
        inst = self._make_instance()

        question = _MockQuestion()
        question.addQuestion('What is ML?')
        question.addDocuments(_MockDoc(page_content='doc1'))
        question.addDocuments(_MockDoc(page_content='doc2'))

        inst.writeQuestions(question)

        inst.instance.writeAnswers.assert_called_once()

    def test_write_questions_no_query_raises(self):
        """WriteQuestions raises ValueError when no query text is provided."""
        inst = self._make_instance()

        question = _MockQuestion()
        question.addDocuments(_MockDoc(page_content='doc'))

        with pytest.raises(ValueError, match='No query text found'):
            inst.writeQuestions(question)

    def test_write_questions_no_documents_raises(self):
        """WriteQuestions raises ValueError when no documents are provided."""
        inst = self._make_instance()

        question = _MockQuestion()
        question.addQuestion('query')

        with pytest.raises(ValueError, match='No documents found'):
            inst.writeQuestions(question)

    def test_write_questions_empty_page_content_raises(self):
        """WriteQuestions raises ValueError when all documents have empty content."""
        inst = self._make_instance()

        question = _MockQuestion()
        question.addQuestion('query')
        question.addDocuments(_MockDoc(page_content=''))

        with pytest.raises(ValueError, match='No document content found'):
            inst.writeQuestions(question)

    def test_write_questions_no_reranker_raises(self):
        """WriteQuestions raises RuntimeError when reranker is not initialized."""
        inst = self._make_instance()
        inst.IGlobal._reranker = None

        question = _MockQuestion()
        question.addQuestion('query')
        question.addDocuments(_MockDoc(page_content='doc'))

        with pytest.raises(RuntimeError, match='Reranker not initialized'):
            inst.writeQuestions(question)

    def test_write_questions_preserves_metadata(self):
        """WriteQuestions preserves original document metadata in reranked output."""
        rerank_results = [
            {'index': 0, 'relevance_score': 0.9, 'document': 'doc content'},
        ]
        inst = self._make_instance(rerank_results=rerank_results)

        metadata = {'objectId': 'obj-123', 'source': 'test-file.txt'}
        question = _MockQuestion()
        question.addQuestion('query')
        question.addDocuments(_MockDoc(page_content='doc content', metadata=metadata))

        inst.writeQuestions(question)

        docs = inst.instance.writeDocuments.call_args[0][0]
        # After deep copy, metadata is equal but not the same object
        assert docs[0].metadata == metadata
        assert docs[0].metadata['objectId'] == 'obj-123'

    def test_write_questions_metadata_alignment_after_filter(self):
        """Regression test for metadata misalignment bug.

        When some of the question.documents entries are skipped while
        building doc_texts (because their page_content is empty), the
        rerank result's ``index`` refers to the FILTERED doc_texts list,
        not to the original question.documents list. The IInstance code
        must use a parallel tracking list (``original_indices``) to map
        each rerank index back to the correct original document so that
        metadata is preserved.

        Concrete scenario:
            question.documents = [A, B, C, D]  (B has empty page_content)
            doc_texts          = [A, C, D]     (B dropped)
            Cohere returns index=1 -> C in the filtered list

        BUG: using question.documents[1] would return B's metadata.
        FIX: using original_indices[1] -> 2, question.documents[2] -> C.
        """
        # Cohere returns the FILTERED-list index 1 which must map to C
        rerank_results = [
            {'index': 1, 'relevance_score': 0.95, 'document': 'doc C content'},
        ]
        inst = self._make_instance(rerank_results=rerank_results)

        meta_a = {'objectId': 'A', 'source': 'a.txt'}
        meta_b = {'objectId': 'B', 'source': 'b.txt'}
        meta_c = {'objectId': 'C', 'source': 'c.txt'}
        meta_d = {'objectId': 'D', 'source': 'd.txt'}

        question = _MockQuestion()
        question.addQuestion('find C')
        question.addDocuments(_MockDoc(page_content='doc A content', metadata=meta_a))
        # B is dropped from doc_texts because page_content is empty
        question.addDocuments(_MockDoc(page_content='', metadata=meta_b))
        question.addDocuments(_MockDoc(page_content='doc C content', metadata=meta_c))
        question.addDocuments(_MockDoc(page_content='doc D content', metadata=meta_d))

        inst.writeQuestions(question)

        # Verify that only non-empty docs were forwarded to the reranker
        call_kwargs = inst.IGlobal._reranker.rerank_with_threshold.call_args
        assert call_kwargs.kwargs['documents'] == [
            'doc A content',
            'doc C content',
            'doc D content',
        ]

        # Verify the output doc has C's metadata (NOT B's, which would be
        # the bug — B sits at question.documents[1] in the unfiltered list).
        docs = inst.instance.writeDocuments.call_args[0][0]
        assert len(docs) == 1
        assert docs[0].page_content == 'doc C content'
        assert docs[0].metadata == meta_c
        assert docs[0].metadata['objectId'] == 'C'
        # Explicit guard against the original bug: metadata must not be B's.
        assert docs[0].metadata['objectId'] != 'B'

    def test_write_questions_empty_rerank_results(self):
        """WriteQuestions with no rerank results still writes an answer."""
        inst = self._make_instance(rerank_results=[])

        question = _MockQuestion()
        question.addQuestion('query')
        question.addDocuments(_MockDoc(page_content='doc'))

        inst.writeQuestions(question)

        inst.instance.writeDocuments.assert_not_called()
        # An answer is always forwarded, even when all docs are filtered
        inst.instance.writeAnswers.assert_called_once()

    def test_write_questions_dict_style_question(self):
        """WriteQuestions handles dict-style question text objects."""
        rerank_results = [
            {'index': 0, 'relevance_score': 0.85, 'document': 'doc'},
        ]
        inst = self._make_instance(rerank_results=rerank_results)

        question = _MockQuestion()
        # Simulate a dict-style question text (some serialization paths)
        question.questions = [{'text': 'dict query'}]
        question.addDocuments(_MockDoc(page_content='doc'))

        inst.writeQuestions(question)

        call_kwargs = inst.IGlobal._reranker.rerank_with_threshold.call_args
        assert call_kwargs.kwargs['query'] == 'dict query'

    def test_write_questions_does_not_mutate_original(self):
        """WriteQuestions must not mutate the original question object (fan-out safety)."""
        rerank_results = [
            {'index': 0, 'relevance_score': 0.90, 'document': 'doc A'},
        ]
        inst = self._make_instance(rerank_results=rerank_results)

        question = _MockQuestion()
        question.addQuestion('What is AI?')
        original_doc = _MockDoc(page_content='doc A', metadata={'source': 'test'})
        question.addDocuments(original_doc)

        # Capture the original documents list before the call
        original_documents = list(question.documents)

        inst.writeQuestions(question)

        # The original question's documents must be unchanged
        assert question.documents == original_documents
        assert len(question.documents) == 1
        assert question.documents[0] is original_doc


# ===========================================================================
# Exception Hierarchy & Circuit Breaker Compatibility Tests
# ===========================================================================


class TestRerankExceptions:
    """Tests for custom exception types and circuit breaker compatibility."""

    def test_all_errors_inherit_from_rerank_error(self):
        """All custom rerank exceptions inherit from RerankError."""
        assert issubclass(RerankAuthenticationError, RerankError)
        assert issubclass(RerankRateLimitError, RerankError)
        assert issubclass(RerankBadRequestError, RerankError)
        assert issubclass(RerankServerError, RerankError)

    def test_rerank_error_inherits_from_exception(self):
        """RerankError inherits from Exception (not ValueError)."""
        assert issubclass(RerankError, Exception)
        assert not issubclass(RerankError, ValueError)

    def test_circuit_breaker_retryable_heuristic_rate_limit(self):
        """RerankRateLimitError class name contains 'RateLimit' for circuit breaker."""
        assert 'RateLimit' in RerankRateLimitError.__name__

    def test_circuit_breaker_retryable_heuristic_server_error(self):
        """RerankServerError class name contains 'ServerError' for circuit breaker."""
        assert 'ServerError' in RerankServerError.__name__

    def test_circuit_breaker_non_retryable_heuristic_auth(self):
        """RerankAuthenticationError class name contains 'Authentication' for circuit breaker."""
        assert 'Authentication' in RerankAuthenticationError.__name__

    def test_circuit_breaker_non_retryable_heuristic_bad_request(self):
        """RerankBadRequestError class name contains 'BadRequest' for circuit breaker."""
        assert 'BadRequest' in RerankBadRequestError.__name__

    def test_exception_preserves_original_cause(self):
        """Custom exceptions preserve the original Cohere exception via __cause__."""
        client_config = {
            'model': 'rerank-v3.5',
            'top_n': 3,
            'min_score': 0.0,
            'apikey': 'test-api-key',
        }
        response = _make_mock_rerank_response([])
        mock_cohere_client = _make_cohere_client_mock(response)

        with patch('rerank_cohere.rerank_client.CohereClient', return_value=mock_cohere_client):
            client = RerankClient('rerank_cohere', client_config, {})

        original_error = _MockUnauthorizedError('original error')
        client._client.rerank.side_effect = original_error

        with pytest.raises(RerankAuthenticationError) as exc_info:
            client.rerank(query='q', documents=['d'])

        assert exc_info.value.__cause__ is original_error
