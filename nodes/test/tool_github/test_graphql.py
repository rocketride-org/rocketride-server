# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The graphql tool: envelope, errors as results, read-only mutation refusal, response cap."""

import gzip
import io
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from urllib3.response import HTTPResponse

from ._stubs import scoped_stubs

TOKEN = 'sentinel-graphql-token-2592'
GRAPHQL_URL = 'https://api.github.com/graphql'
HEADERS = {
    'X-RateLimit-Remaining': '4990',
    'X-RateLimit-Limit': '5000',
    'X-RateLimit-Reset': '2000000000',
    'X-RateLimit-Resource': 'graphql',
}
RATE = {'remaining': 4990, 'limit': 5000, 'reset': 2000000000, 'resource': 'graphql'}
VIEWER = 'query { viewer { login } }'
MUTATION = 'mutation { addStar(input: {starrableId: "R_1"}) { clientMutationId } }'


class CountingStream(io.BytesIO):
    """A response body that records how much of it was read, and whether it was closed."""

    consumed = 0

    def read(self, size=-1):
        chunk = super().read(size)
        self.consumed += len(chunk)
        return chunk


def gql_response(payload=None, status=200, headers=None, raw=None):
    """A streamed response, as requests returns it with stream=True."""
    resp = requests.Response()
    resp.status_code = status
    resp.headers.update(HEADERS if headers is None else headers)
    resp.raw = CountingStream(raw if raw is not None else json.dumps(payload).encode())
    return resp


@pytest.fixture
def node(monkeypatch):
    with scoped_stubs():
        from tool_github import IInstance
        from tool_github import github_client, graphql_guard

        inst = IInstance()
        sleep = Mock()
        inst.IGlobal = SimpleNamespace(
            auth_type='pat',
            token=TOKEN,
            private_key_pem='',
            default_repo='owner/repo',
            read_only=True,
            get_token=Mock(return_value=TOKEN),
            tools=frozenset(),
            graphql_max_bytes=github_client.DEFAULT_GRAPHQL_MAX_BYTES,
            graphql_allow_mutations=False,
            retry_policy=github_client.RetryPolicy(sleep=sleep),
        )
        request = Mock()
        monkeypatch.setattr(github_client.requests, 'request', request)
        yield SimpleNamespace(inst=inst, request=request, client=github_client, client_guard=graphql_guard, sleep=sleep)


def test_success_returns_data_and_the_requested_rate_limit_block(node):
    query = 'query { viewer { login } rateLimit { cost remaining resetAt } }'
    data = {
        'viewer': {'login': 'octocat'},
        'rateLimit': {'cost': 1, 'remaining': 4990, 'resetAt': '2033-05-18T03:33:20Z'},
    }
    node.request.return_value = gql_response({'data': data})
    result = node.inst.graphql({'query': query})
    assert result == {
        'status': 200,
        'data': {'data': data, 'errors': None},
        'rate_limit': RATE,
        'next_page': None,
    }
    assert node.request.call_args.args == ('POST', GRAPHQL_URL)
    kwargs = node.request.call_args.kwargs
    assert kwargs['json'] == {'query': query}
    assert kwargs['stream'] is True
    assert kwargs['headers']['Authorization'] == f'Bearer {TOKEN}'
    assert TOKEN not in json.dumps(result)


def test_paginated_pull_requests_keep_page_info(node):
    page = {
        'repository': {
            'pullRequests': {
                'pageInfo': {'hasNextPage': True, 'endCursor': 'Y3Vyc29yOjQw'},
                'nodes': [{'number': n, 'reviewDecision': 'APPROVED'} for n in range(40)],
            }
        }
    }
    node.request.return_value = gql_response({'data': page})
    result = node.inst.graphql({'query': 'query($after: String) { repository(owner: "o", name: "r") { id } }'})
    assert result['data']['data']['repository']['pullRequests']['pageInfo']['endCursor'] == 'Y3Vyc29yOjQw'
    assert len(result['data']['data']['repository']['pullRequests']['nodes']) == 40


@pytest.mark.parametrize(
    'body',
    [
        {
            'data': None,
            'errors': [
                {
                    'type': 'NOT_FOUND',
                    'path': ['repository'],
                    'locations': [{'line': 1, 'column': 9}],
                    'message': "Could not resolve to a Repository with the name 'owner/missing'.",
                }
            ],
        },
        {
            'data': {'viewer': {'login': 'octocat'}, 'repository': None},
            'errors': [{'type': 'FORBIDDEN', 'path': ['repository'], 'message': 'Resource not accessible'}],
        },
        {'errors': [{'message': 'Parse error on "}" (RCURLY) at [1, 3]'}]},
    ],
)
def test_graphql_errors_are_returned_not_raised(node, body):
    node.request.return_value = gql_response(body)
    result = node.inst.graphql({'query': VIEWER})
    assert result['status'] == 200
    assert result['data'] == {'data': body.get('data'), 'errors': body['errors']}
    assert node.request.call_count == 1


def test_variables_are_passed_through_unchanged(node):
    variables = {'owner': 'acme', 'after': None, 'first': 40, 'labels': ['bug', 'p1'], 'filter': {'states': ['OPEN']}}
    node.request.return_value = gql_response({'data': {}})
    node.inst.graphql({'query': 'query($owner: String!) { viewer { login } }', 'variables': variables})
    assert node.request.call_args.kwargs['json'] == {
        'query': 'query($owner: String!) { viewer { login } }',
        'variables': variables,
    }


@pytest.mark.parametrize(
    'args',
    [
        {},
        {'query': ''},
        {'query': '   '},
        {'query': 7},
        {'query': VIEWER, 'variables': '{"a": 1}'},
        {'query': VIEWER, 'variables': [1]},
    ],
)
def test_invalid_inputs_are_refused_before_anything_is_sent(node, args):
    with pytest.raises(ValueError, match='graphql'):
        node.inst.graphql(args)
    node.request.assert_not_called()
    node.inst.IGlobal.get_token.assert_not_called()


@pytest.mark.parametrize(
    'query',
    [
        MUTATION,
        'mutation AddStar { addStar(input: {starrableId: "R_1"}) { clientMutationId } }',
        'mutation AddStar($id: ID!) { addStar(input: {starrableId: $id}) { clientMutationId } }',
        'mutation($id: ID! = "R_1") @client { addStar(input: {starrableId: $id}) { clientMutationId } }',
        'query Read { viewer { login } }\nmutation Write { addStar(input: {starrableId: "R_1"}) { clientMutationId } }',
        '# star it\nmutation { addStar(input: {starrableId: "R_1"}) { clientMutationId } }',
        'query Q { search(query: """}""", type: ISSUE, first: 1) { issueCount } } mutation { a }',
        '\ufeff,,mutation{a}',
        # Balanced braces hidden in strings or comments must not bury the mutation at depth one.
        'query Q($x: String = "{") { a } mutation { b } query R($y: String = "}") { c }',
        'query Q { a } # {\nmutation { b }\n# }',
        'query { a } # note\rmutation { b }',
    ],
    ids=[
        'anonymous',
        'named',
        'variables',
        'default-and-directive',
        'second-operation',
        'after-comment',
        'after-block-string',
        'bom-and-commas',
        'braces-in-strings-around',
        'braces-in-comments-around',
        'carriage-return-ends-the-comment',
    ],
)
def test_mutation_is_refused_in_read_only_mode(node, query):
    result = node.inst.graphql({'query': query})
    assert result['status'] is None
    assert 'readOnly' in result['message']
    assert 'mutation' in result['message']
    assert 'data' not in result
    node.request.assert_not_called()
    node.inst.IGlobal.get_token.assert_not_called()


@pytest.mark.parametrize(
    'query',
    [
        '# not a mutation: reads only\nquery { viewer { login } }',
        'query { viewer { login } } # mutation { addStar }',
        'query { search(query: "mutation { addStar }", type: ISSUE, first: 1) { issueCount } }',
        'query { search(query: "say \\"mutation {\\" twice", type: ISSUE, first: 1) { issueCount } }',
        'query { search(query: """\nmutation {\n""", type: ISSUE, first: 1) { issueCount } }',
        'query { search(query: """a \\""" mutation {""", type: ISSUE, first: 1) { issueCount } }',
        'query { repository(owner: "o", name: "r") { mutation: name } }',
        'query mutationAudit { viewer { login } }',
        '{ viewer { login } }',
        'query { mutation }',
        'query { a(mutation: 1) { b } }',
        'query($mutation: Int) { a(first: $mutation) { b } }',
        '# mutation {\rquery { viewer { login } }',
    ],
    ids=[
        'comment-line',
        'trailing-comment',
        'string',
        'escaped-quote',
        'block-string',
        'escaped-block-quote',
        'alias',
        'name-prefix',
        'shorthand',
        'field',
        'argument',
        'variable',
        'carriage-return-comment',
    ],
)
def test_the_word_mutation_outside_an_operation_keyword_does_not_refuse(node, query):
    node.request.return_value = gql_response({'data': {}})
    result = node.inst.graphql({'query': query})
    assert result['status'] == 200
    assert node.request.call_args.kwargs['json']['query'] == query


@pytest.mark.parametrize(
    'query',
    [
        'query { a(x: "mutation) }',
        'query { a(x: "line\nbreak") }',
        'query { a(x: """never closed) }',
        'query { a } }',
        'query { a',
    ],
    ids=['unterminated-string', 'line-break-in-string', 'unterminated-block-string', 'extra-close', 'unclosed'],
)
def test_documents_that_cannot_be_checked_are_refused_in_read_only_mode(node, query):
    result = node.inst.graphql({'query': query})
    assert result['status'] is None
    assert 'readOnly' in result['message']
    assert 'cannot be checked' in result['message']
    node.request.assert_not_called()


def test_operation_name_picks_one_of_two_operations(node):
    query = 'query Viewer { viewer { login } }\nquery Limits { rateLimit { remaining } }'
    node.request.return_value = gql_response({'data': {'rateLimit': {'remaining': 4990}}})
    result = node.inst.graphql({'query': query, 'operationName': 'Limits'})
    assert result['data']['data'] == {'rateLimit': {'remaining': 4990}}
    assert node.request.call_args.kwargs['json'] == {'query': query, 'operationName': 'Limits'}


def test_operation_name_does_not_exempt_a_mutation_in_read_only_mode(node):
    query = (
        'query Read { viewer { login } }\nmutation Write { addStar(input: {starrableId: "R_1"}) { clientMutationId } }'
    )
    result = node.inst.graphql({'query': query, 'operationName': 'Read'})
    assert result['status'] is None
    assert 'readOnly' in result['message']
    node.request.assert_not_called()


@pytest.mark.parametrize('operation_name', [7, '', '   ', ['Read']])
def test_invalid_operation_name_is_refused_before_anything_is_sent(node, operation_name):
    with pytest.raises(ValueError, match='operationName'):
        node.inst.graphql({'query': VIEWER, 'operationName': operation_name})
    node.request.assert_not_called()


@pytest.mark.parametrize(
    'query',
    [MUTATION, 'query Q { viewer { login } } mutation M { addStar(input: {starrableId: "x"}) { clientMutationId } }'],
)
def test_mutation_is_refused_with_read_only_off_until_mutations_are_allowed(node, query):
    node.inst.IGlobal.read_only = False
    result = node.inst.graphql({'query': query})
    assert result['status'] is None
    assert 'data' not in result
    assert result['message'].startswith(
        'graphql refused: the document contains a mutation operation, and graphqlAllowMutations is off.'
    )
    assert 'readOnly' not in result['message']
    node.request.assert_not_called()


def test_an_uncheckable_document_is_refused_with_read_only_off_until_mutations_are_allowed(node):
    node.inst.IGlobal.read_only = False
    result = node.inst.graphql({'query': 'query { viewer { login '})
    assert result['status'] is None
    assert 'cannot be checked for a mutation operation, and graphqlAllowMutations is off' in result['message']
    node.request.assert_not_called()


def test_mutation_is_sent_when_read_only_is_off_and_mutations_are_allowed(node):
    node.inst.IGlobal.read_only = False
    node.inst.IGlobal.graphql_allow_mutations = True
    node.request.return_value = gql_response({'data': {'addStar': {'clientMutationId': None}}})
    result = node.inst.graphql({'query': MUTATION})
    assert result['status'] == 200
    assert result['data']['data'] == {'addStar': {'clientMutationId': None}}
    assert node.request.call_args.kwargs['json'] == {'query': MUTATION}


@pytest.mark.parametrize('query', [VIEWER, MUTATION])
@pytest.mark.parametrize('failure', ['timeout', 'connection', 'invalid-json', 'response-cap'])
def test_ambiguous_mutation_outcome_does_not_advise_blind_retry(node, query, failure):
    node.inst.IGlobal.read_only = False
    node.inst.IGlobal.graphql_allow_mutations = True
    if failure in {'timeout', 'connection'}:
        error = requests.Timeout if failure == 'timeout' else requests.ConnectionError
        node.request.side_effect = error(TOKEN)
    elif failure == 'invalid-json':
        node.request.return_value = gql_response(raw=f'not JSON: {TOKEN}'.encode())
    else:
        node.inst.IGlobal.graphql_max_bytes = 1024
        node.request.return_value = gql_response({'data': {'large': 'x' * 2048}})
    result = node.inst.graphql({'query': query})
    assert result['status'] is None
    assert TOKEN not in json.dumps(result)
    assert node.request.call_count == 1
    node.sleep.assert_not_called()
    if query == MUTATION:
        assert 'mutation may already have been applied' in result['message']
        assert 'Check its current state before retrying' in result['message']
        assert 'Check connectivity and retry' not in result['message']
    else:
        assert 'mutation may already have been applied' not in result['message']


@pytest.mark.parametrize('query', [VIEWER, MUTATION])
@pytest.mark.parametrize('status', [500, 502, 504])
def test_server_error_preserves_status_and_warns_only_for_mutations(node, query, status):
    node.inst.IGlobal.read_only = False
    node.inst.IGlobal.graphql_allow_mutations = True
    node.request.return_value = gql_response({'message': f'Upstream failure {TOKEN}'}, status=status)
    result = node.inst.graphql({'query': query})
    assert result['status'] == status
    assert TOKEN not in json.dumps(result)
    assert ('mutation may already have been applied' in result['message']) is (query == MUTATION)
    node.request.assert_called_once()
    node.sleep.assert_not_called()


def test_oversized_response_is_an_error_naming_the_cap_and_is_not_read_in_full(node):
    node.inst.IGlobal.graphql_max_bytes = 1024
    body = json.dumps({'data': {'blob': 'x' * (640 * 1024)}}).encode()
    resp = gql_response(raw=body)
    node.request.return_value = resp
    result = node.inst.graphql({'query': VIEWER})
    assert result['status'] is None
    assert 'graphqlMaxResponseBytes' in result['message']
    assert '1024 bytes' in result['message']
    assert 'data' not in result
    assert result['rate_limit'] == RATE
    # Reading stopped at the first chunk past the cap, far short of the 640 KiB body.
    assert resp.raw.consumed <= 64 * 1024 < len(body)
    assert resp.raw.closed


def test_declared_oversized_response_is_refused_without_reading(node):
    node.inst.IGlobal.graphql_max_bytes = 1024
    resp = gql_response(raw=b'{"data": {}}' + b' ' * 4096, headers={**HEADERS, 'Content-Length': '4108'})
    node.request.return_value = resp
    result = node.inst.graphql({'query': VIEWER})
    assert 'graphqlMaxResponseBytes' in result['message']
    assert resp.raw.consumed == 0
    assert resp.raw.closed


def test_encoded_length_over_the_cap_is_not_trusted(node):
    # A gzip Content-Length counts compressed bytes; the decoded body is what the cap bounds.
    node.inst.IGlobal.graphql_max_bytes = 1024
    headers = {**HEADERS, 'Content-Length': '4096', 'Content-Encoding': 'gzip'}
    node.request.return_value = gql_response({'data': {'ok': True}}, headers=headers)
    assert node.inst.graphql({'query': VIEWER})['data'] == {'data': {'ok': True}, 'errors': None}


def test_response_at_the_cap_is_accepted(node):
    body = json.dumps({'data': {'v': ''}}).encode()
    body = body[:-2] + b' ' * (1024 - len(body)) + body[-2:]
    assert len(body) == 1024
    node.inst.IGlobal.graphql_max_bytes = 1024
    node.request.return_value = gql_response(raw=body)
    assert node.inst.graphql({'query': VIEWER})['data'] == {'data': {'v': ''}, 'errors': None}


@pytest.mark.parametrize(
    ('status', 'body', 'message'),
    [
        (
            401,
            {'message': 'Bad credentials', 'documentation_url': 'https://docs.github.com/graphql'},
            'Bad credentials',
        ),
        (502, None, 'GitHub returned HTTP 502 without a JSON error body.'),
        (400, {'errors': [{'message': 'Problems parsing JSON'}]}, 'Problems parsing JSON'),
    ],
)
def test_http_errors_are_structured_results(node, status, body, message):
    raw = b'<html>Bad gateway</html>' if body is None else json.dumps(body).encode()
    node.request.return_value = gql_response(raw=raw, status=status)
    result = node.inst.graphql({'query': VIEWER})
    assert result['status'] == status
    assert result['message'] == message
    assert result['rate_limit'] == RATE
    assert result['next_page'] is None
    assert 'data' not in result
    assert result.get('errors') == (body or {}).get('errors')
    assert result['documentation_url'] == (body or {}).get('documentation_url')


def test_non_json_success_body_is_a_safe_failure(node):
    node.request.return_value = gql_response(raw=b'<html>ok</html>')
    result = node.inst.graphql({'query': VIEWER})
    assert result['status'] is None
    assert result['rate_limit'] == dict.fromkeys(('remaining', 'limit', 'reset', 'resource'))
    assert 'data' not in result


@pytest.mark.parametrize(
    ('raw', 'message', 'documentation_url'),
    [
        (b'[1, 2]', 'GitHub returned an unexpected response body; expected a JSON object with data or errors.', None),
        (b'null', 'GitHub returned an unexpected response body; expected a JSON object with data or errors.', None),
        (
            b'{"message": "no data key", "documentation_url": "https://docs.github.com/x"}',
            'no data key',
            'https://docs.github.com/x',
        ),
    ],
)
def test_json_success_body_of_the_wrong_shape_keeps_status_and_counters(node, raw, message, documentation_url):
    node.request.return_value = gql_response(raw=raw)
    result = node.inst.graphql({'query': VIEWER})
    assert result == {
        'status': 200,
        'message': message,
        'documentation_url': documentation_url,
        'rate_limit': RATE,
        'next_page': None,
    }


@pytest.mark.parametrize(
    'query',
    [
        'query mutation { viewer { login } }',
        'fragment mutation on Repository { id } query { viewer { login } }',
        'fragment F on mutation { id } query { viewer { login } }',
        'query Q @mutation { viewer { login } }',
    ],
    ids=['operation-named-mutation', 'fragment-named-mutation', 'on-mutation', 'top-level-directive'],
)
def test_documented_over_refusals(node, query):
    result = node.inst.graphql({'query': query})
    assert result['message'] == node.client_guard.MUTATION_REFUSED
    node.request.assert_not_called()


def gzip_response(payload):
    """A gzip body decoded by urllib3, as a real streamed response is."""
    compressed = gzip.compress(json.dumps(payload).encode())
    headers = {**HEADERS, 'Content-Encoding': 'gzip', 'Content-Length': str(len(compressed))}
    resp = requests.Response()
    resp.status_code = 200
    resp.headers.update(headers)
    resp.raw = HTTPResponse(
        body=io.BytesIO(compressed), headers=headers, status=200, preload_content=False, decode_content=True
    )
    return resp, len(compressed)


def test_real_gzip_body_is_capped_by_its_decoded_size(node):
    resp, compressed = gzip_response({'data': {'blob': 'x' * (5 * 1024 * 1024)}})
    assert compressed < node.client.DEFAULT_GRAPHQL_MAX_BYTES
    node.request.return_value = resp
    result = node.inst.graphql({'query': VIEWER})
    assert result['status'] is None
    assert 'graphqlMaxResponseBytes (4194304 bytes)' in result['message']


def test_real_gzip_body_under_the_cap_is_decoded(node):
    resp, _ = gzip_response({'data': {'viewer': {'login': 'octocat'}}})
    node.request.return_value = resp
    result = node.inst.graphql({'query': VIEWER})
    assert result['data'] == {'data': {'viewer': {'login': 'octocat'}}, 'errors': None}


@pytest.mark.parametrize(
    'case',
    ['data', 'errors', 'error-message', 'documentation-url', 'transport', 'auth', 'rate-limit'],
)
def test_sentinel_token_never_reaches_a_result(node, case):
    echoed = f'token {TOKEN} was used'
    inst = node.inst
    if case == 'data':
        node.request.return_value = gql_response({'data': {'echo': echoed}})
    elif case == 'errors':
        node.request.return_value = gql_response({'data': None, 'errors': [{'message': echoed, 'path': [TOKEN]}]})
    elif case == 'error-message':
        node.request.return_value = gql_response({'message': echoed}, status=401)
    elif case == 'documentation-url':
        node.request.return_value = gql_response({'message': 'x', 'documentation_url': f'https://x.test/{TOKEN}'}, 404)
    elif case == 'transport':
        node.request.side_effect = requests.ConnectionError(echoed)
    elif case == 'auth':
        inst.IGlobal.get_token.side_effect = ValueError(echoed)
    else:
        inst.IGlobal.retry_policy = node.client.RetryPolicy(max_retries=0, sleep=node.sleep)
        node.request.return_value = gql_response({'message': echoed}, 403, {**HEADERS, 'Retry-After': '5'})
    result = inst.graphql({'query': VIEWER})
    assert TOKEN not in json.dumps(result)
    assert TOKEN not in str(result)


def test_private_key_and_configured_token_are_redacted_under_app_auth(node, rsa_private_key_pem):
    # The installation token is redacted by the client; the PEM and any PAT only by the node.
    node.inst.IGlobal.auth_type = 'app'
    node.inst.IGlobal.token = 'sentinel-pat-left-in-config'
    node.inst.IGlobal.private_key_pem = rsa_private_key_pem
    node.inst.IGlobal.get_token.return_value = 'installation-sentinel'
    echoed = f'{rsa_private_key_pem} sentinel-pat-left-in-config installation-sentinel'
    node.request.return_value = gql_response({'data': None, 'errors': [{'message': echoed}]})
    result = node.inst.graphql({'query': VIEWER})
    dumped = json.dumps(result)
    for secret in (rsa_private_key_pem, 'sentinel-pat-left-in-config', 'installation-sentinel'):
        assert secret not in dumped
    assert '[REDACTED]' in result['data']['errors'][0]['message']
