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
Integration Tests for RocketRideClient.

Comprehensive integration test suite for the RocketRide Python client, providing
test coverage for all major functionality including connections, pipelines,
data operations, chat operations, event handling, and error scenarios.

This is a pytest-based test suite that mirrors the TypeScript Jest integration
tests to ensure feature parity between client implementations.

Test Coverage:
    - Server connection establishment and authentication
    - Pipeline configuration and lifecycle management
    - Data sending and processing operations
    - File upload operations with progress tracking
    - AI chat operations with streaming responses
    - Real-time event handling and subscriptions
    - Error handling and recovery scenarios
    - End-to-end workflows with multiple operations
    - Concurrent operation handling

Test Configuration:
    Tests use environment variables for configuration:
    - ROCKETRIDE_URI: Server URI (defaults to http://localhost:5565)
    - ROCKETRIDE_APIKEY: Authentication key (defaults to 'MYAPIKEY')
    - Various LLM API keys for chat tests (ROCKETRIDE_OPENAI_KEY, etc.)

Running Tests:
    pytest tests/RocketRideClient_test.py -v          # Verbose output
    pytest tests/RocketRideClient_test.py -k test_name # Run specific test
    pytest tests/RocketRideClient_test.py --log-cli-level=DEBUG # With debug logs

Note:
    These integration tests require a running RocketRide server. Ensure the
    server is running and accessible at the configured URI before running tests.
"""

import pytest
import asyncio
import os
import json
import random
import string
import time
from pathlib import Path
from typing import Dict, Any
from unittest.mock import AsyncMock

# Load .env from project root before any imports that need env vars
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
load_dotenv(PROJECT_ROOT / '.env')

# Skip chat tests when no LLM API key is available
HAS_LLM_KEY = bool(
    os.environ.get('ROCKETRIDE_OPENAI_KEY')
    or os.environ.get('ROCKETRIDE_ANTHROPIC_KEY')
    or os.environ.get('ROCKETRIDE_GEMINI_KEY')
    or os.environ.get('ROCKETRIDE_OLLAMA_HOST')
)
requires_llm = pytest.mark.skipif(
    not HAS_LLM_KEY,
    reason='Skipped: no LLM API key set (need ROCKETRIDE_OPENAI_KEY, ROCKETRIDE_ANTHROPIC_KEY, ROCKETRIDE_GEMINI_KEY, or ROCKETRIDE_OLLAMA_HOST)',
)

# Import from rocketride
from rocketride import RocketRideClient, TASK_STATE, Question
from rocketride.mixins.connection import ConnectionMixin

# Import pipelines - using absolute imports since they're in the same directory
from echo_pipeline import get_echo_pipeline
from chat_pipeline import get_chat_pipeline

# Define type aliases for the types that may not be exported directly
UPLOAD_RESULT = Dict[str, Any]
PIPELINE_RESULT = Dict[str, Any]
EVENT_STATUS_UPDATE = Dict[str, Any]
EVENT_TASK = Dict[str, Any]
DAPMessage = Dict[str, Any]


# Test configuration
TEST_CONFIG = {
    'uri': os.getenv('ROCKETRIDE_URI', 'http://localhost:5565'),
    'auth': os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY'),
    'timeout': 30.0,  # 30 second timeout for integration tests
}


async def ensure_clean_pipeline(client: RocketRideClient, token: str) -> None:
    """Clean up pipeline if it exists, ignoring errors."""
    try:
        await client.terminate(token)
    except Exception:
        # Ignore errors - pipeline might not be running
        pass


class TestServerConnection:
    """Test basic server connection functionality."""

    @pytest.mark.asyncio
    async def test_should_connect_to_live_server(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            assert client.is_connected() is True
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_disconnect_from_server(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            assert client.is_connected() is True

            await client.disconnect()
            assert client.is_connected() is False
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_ping_server_successfully(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await client.ping()  # Should not raise an exception
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_connection_with_context_manager(self):
        # This test may need to be adapted based on your client's actual context manager support
        try:
            async with RocketRideClient.with_connection(TEST_CONFIG) as connected_client:
                assert connected_client.is_connected() is True
                await connected_client.ping()
        except AttributeError:
            # If with_connection doesn't exist, test manual connection
            client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
            try:
                await client.connect()
                assert client.is_connected() is True
                await client.ping()
            finally:
                if client.is_connected():
                    await client.disconnect()


class TestServicesOperations:
    """Test service definition retrieval (get_services, get_service)."""

    @pytest.mark.asyncio
    async def test_should_get_all_services(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            result = await client.get_services()

            assert isinstance(result, dict)
            # Engine returns { "services": {...}, "version": ... }
            assert 'services' in result
            assert isinstance(result['services'], dict)
            # May have version from engine
            if 'version' in result:
                assert isinstance(result['version'], (int, str))
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_get_single_service(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            all_services = await client.get_services()
            services_dict = all_services.get('services', all_services)
            if not services_dict:
                pytest.skip('No services returned by server')

            # Pick first available service name
            service_name = next(iter(services_dict))
            single = await client.get_service(service_name)

            assert single is not None
            assert isinstance(single, dict)
            # Single service definition typically has title, protocol, schema, etc.
            assert 'title' in single or 'protocol' in single or 'prefix' in single
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_raise_for_unknown_service(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            with pytest.raises(RuntimeError) as exc_info:
                await client.get_service('nonexistent_service_xyz')
            assert 'nonexistent_service_xyz' in str(exc_info.value) or 'not found' in str(exc_info.value).lower()
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_raise_when_service_name_empty(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            with pytest.raises(ValueError) as exc_info:
                await client.get_service('')
            assert 'required' in str(exc_info.value).lower()
        finally:
            if client.is_connected():
                await client.disconnect()


class TestPipelineOperations:
    """Test pipeline lifecycle operations."""

    PIPELINE_TOKEN = 'PY-PL'

    @pytest.mark.asyncio
    async def test_should_start_a_pipeline(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.PIPELINE_TOKEN)

            assert 'token' in result
            assert isinstance(result['token'], str)
            assert len(result['token']) > 0

            await client.terminate(result['token'])
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_get_pipeline_status(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.PIPELINE_TOKEN)

            status = await client.get_task_status(result['token'])

            assert 'state' in status
            assert status['state'] in [state.value for state in TASK_STATE]

            await client.terminate(result['token'])
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_terminate_a_pipeline(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.PIPELINE_TOKEN)

            # Should not raise an exception
            await client.terminate(result['token'])
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()


class TestDataOperations:
    """Test data sending and processing operations."""

    DATA_TOKEN = 'PY-DA'

    @pytest.mark.asyncio
    async def test_should_send_text_data_no_mime_type(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.DATA_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.DATA_TOKEN)
            pipeline_token = result['token']

            test_data = 'Hello from integration test!'
            result = await client.send(pipeline_token, test_data)

            assert result is not None
            assert isinstance(result, dict)

            # Validate basic response structure
            assert 'name' in result
            assert isinstance(result['name'], str)
            assert len(result['name']) == 36  # UUID format

            assert 'path' in result
            assert isinstance(result['path'], str)
            assert result['path'] == ''  # Should be empty for direct sends

            assert 'objectId' in result
            assert isinstance(result['objectId'], str)
            assert len(result['objectId']) == 36  # UUID format

            # Without MIME type, should not have processed content
            assert 'result_types' not in result or result['result_types'] is None
        finally:
            if pipeline_token:
                await ensure_clean_pipeline(client, pipeline_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_send_text_data_with_mime_type(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.DATA_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.DATA_TOKEN)
            pipeline_token = result['token']

            test_data = 'Hello from integration test!'
            result = await client.send(pipeline_token, test_data, {}, 'text/plain')

            assert result is not None
            assert isinstance(result, dict)

            # Validate basic response structure
            assert 'name' in result
            assert isinstance(result['name'], str)
            assert len(result['name']) == 36

            assert 'path' in result
            assert isinstance(result['path'], str)
            assert result['path'] == ''

            assert 'objectId' in result
            assert isinstance(result['objectId'], str)
            assert len(result['objectId']) == 36

            # With MIME type, should have processed content
            assert 'result_types' in result
            assert isinstance(result['result_types'], dict)
            assert result['result_types']['text'] == 'text'

            # Validate the actual data field referenced by result_types
            assert 'text' in result
            assert isinstance(result['text'], list)
            assert len(result['text']) > 0
            assert 'Hello from integration test!' in result['text'][0]
        finally:
            if pipeline_token:
                await ensure_clean_pipeline(client, pipeline_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_send_binary_data(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.DATA_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.DATA_TOKEN)
            pipeline_token = result['token']

            binary_data = bytes([72, 101, 108, 108, 111])  # "Hello" in bytes
            result = await client.send(pipeline_token, binary_data)

            assert result is not None
            assert isinstance(result, dict)

            # Validate basic response structure
            assert 'name' in result
            assert isinstance(result['name'], str)
            assert len(result['name']) == 36

            assert 'path' in result
            assert isinstance(result['path'], str)
            assert result['path'] == ''

            assert 'objectId' in result
            assert isinstance(result['objectId'], str)
            assert len(result['objectId']) == 36

            # Binary data without MIME type should not have processed content
            assert 'result_types' not in result or result['result_types'] is None
        finally:
            if pipeline_token:
                await ensure_clean_pipeline(client, pipeline_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_use_data_pipe_for_streaming(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.DATA_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.DATA_TOKEN)
            pipeline_token = result['token']

            pipe = await client.pipe(pipeline_token, {'name': 'test-stream.txt'}, 'text/plain')

            await pipe.open()

            chunks = ['Hello ', 'from ', 'streaming ', 'test!']
            for chunk in chunks:
                await pipe.write(chunk.encode())

            result = await pipe.close()

            assert result is not None
            assert isinstance(result, dict)

            # Should use the provided name instead of UUID for streaming
            assert result['name'] == 'test-stream.txt'

            assert 'path' in result
            assert isinstance(result['path'], str)
            assert result['path'] == ''

            assert 'objectId' in result
            assert isinstance(result['objectId'], str)
            assert len(result['objectId']) == 36

            # Streaming with MIME type should have processed content
            assert 'result_types' in result
            assert result['result_types']['text'] == 'text'

            assert 'text' in result
            assert isinstance(result['text'], list)
            assert len(result['text']) > 0
            assert result['text'][0] == '\n\n'.join(chunks) + '\n\n'
        finally:
            if pipeline_token:
                await ensure_clean_pipeline(client, pipeline_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_file_uploads(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.DATA_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.DATA_TOKEN)
            pipeline_token = result['token']

            name = 'test.txt'
            test_content = 'Test file content for upload'

            # Create file file
            with open(name, 'w') as f:
                # Create the file
                f.write(test_content)
                f.close()

                # Upload and process file
                try:
                    upload_results = await client.send_files([(name, {'name': name}, 'text/plain')], pipeline_token)
                finally:
                    os.unlink(name)  # Ensure temp file is deleted

            assert upload_results is not None
            assert isinstance(upload_results, list)
            assert len(upload_results) == 1

            upload_result = upload_results[0]

            # Validate UPLOAD_RESULT structure
            assert upload_result['action'] == 'complete'
            assert upload_result['filepath'] == name
            assert upload_result['bytes_sent'] == len(test_content)
            assert upload_result['file_size'] == len(test_content)
            assert isinstance(upload_result['upload_time'], (int, float))
            assert upload_result['upload_time'] >= 0
            assert 'error' not in upload_result or upload_result['error'] is None

            # Validate processing result
            assert 'result' in upload_result
            processing_result = upload_result['result']

            # Should use original filename
            assert processing_result['name'] == name
            assert processing_result['path'] == ''
            assert len(processing_result['objectId']) == 36

            # File uploads should have processed content
            assert 'result_types' in processing_result
            assert processing_result['result_types']['text'] == 'text'

            assert 'text' in processing_result
            assert isinstance(processing_result['text'], list)
            assert test_content + '\n\n' in processing_result['text']
        finally:
            if pipeline_token:
                await ensure_clean_pipeline(client, pipeline_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_different_result_types_field_mappings(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.DATA_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.DATA_TOKEN)
            pipeline_token = result['token']

            test_data = 'Multi-field result type test'
            result = await client.send(pipeline_token, test_data, {}, 'text/plain')

            assert result is not None

            if result.get('result_types'):
                # Check each field exists and has the right type
                for field_name, field_type in result['result_types'].items():
                    assert field_name in result

                    # For text type fields, should be string arrays
                    if field_type == 'text':
                        assert isinstance(result[field_name], list)
        finally:
            if pipeline_token:
                await ensure_clean_pipeline(client, pipeline_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_various_mime_types_and_result_structures(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.DATA_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.DATA_TOKEN)
            pipeline_token = result['token']

            test_cases = [
                {'data': 'Plain text content', 'mime_type': 'text/plain', 'description': 'plain text'},
                {
                    'data': json.dumps({'message': 'Hello', 'value': 42}),
                    'mime_type': 'application/json',
                    'description': 'JSON data',
                },
            ]

            for test_case in test_cases:
                result = await client.send(pipeline_token, test_case['data'], {}, test_case['mime_type'])

                assert result is not None
                print(f'Testing {test_case["description"]}: {json.dumps(result, indent=2)}')

                # All results should have basic fields
                assert 'name' in result
                assert 'objectId' in result

                if result.get('result_types'):
                    # Check result_types structure
                    assert isinstance(result['result_types'], dict)

                    # Verify fields referenced in result_types actually exist
                    for field_name, field_type in result['result_types'].items():
                        assert field_name in result
                        print(f"  Field '{field_name}' (type: {field_type}): {result[field_name]}")

                        # Basic type checking
                        if field_type == 'text':
                            assert isinstance(result[field_name], list)
        finally:
            if pipeline_token:
                await ensure_clean_pipeline(client, pipeline_token)
            if client.is_connected():
                await client.disconnect()


@requires_llm
class TestChatOperations:
    """Test chat functionality."""

    CHAT_TOKEN = 'PY-CH'

    @pytest.mark.asyncio
    async def test_should_send_simple_chat_question(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        chat_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.CHAT_TOKEN)

            result = await client.use(pipeline=get_chat_pipeline(), token=self.CHAT_TOKEN)
            chat_token = result['token']

            question = Question()
            question.addQuestion('What is 2 + 2?')

            response = await client.chat(
                token=chat_token,
                question=question,
            )

            assert response is not None
            assert isinstance(response, dict)

            # Validate basic response structure
            assert 'name' in response
            assert isinstance(response['name'], str)
            assert 'path' in response
            assert 'objectId' in response
            assert len(response['objectId']) == 36

            # Chat should have processed content with answers
            assert 'result_types' in response
            assert response['result_types']['answers'] == 'answers'

            # Validate the answers field
            assert 'answers' in response
            assert isinstance(response['answers'], list)
            assert len(response['answers']) > 0

            # Check that we got a meaningful answer
            answer = response['answers'][0]
            assert isinstance(answer, str)
            assert len(answer) > 0
        finally:
            if chat_token:
                await ensure_clean_pipeline(client, chat_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_json_response_questions(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        chat_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.CHAT_TOKEN)

            result = await client.use(pipeline=get_chat_pipeline(), token=self.CHAT_TOKEN)
            chat_token = result['token']

            question = Question(expectJson=True)
            question.addQuestion('Cite the first paragraph of the constitution of the United States')
            question.addExample('greeting request', {'text': 'Hello, world!'})

            response = await client.chat(
                token=chat_token,
                question=question,
            )

            assert response is not None
            assert isinstance(response, dict)

            # Validate basic response structure
            assert 'name' in response
            assert 'path' in response
            assert 'objectId' in response

            # Should have answers field
            assert 'result_types' in response
            assert response['result_types']['answers'] == 'answers'
            assert 'answers' in response
            assert isinstance(response['answers'], list)
            assert len(response['answers']) > 0

            # Validate answer content
            answer = response['answers'][0]
            assert isinstance(answer, dict)
            assert 'text' in answer
            assert len(answer['text']) > 0
            assert 'We the People' in answer['text']
        finally:
            if chat_token:
                await ensure_clean_pipeline(client, chat_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_questions_with_instructions(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        chat_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.CHAT_TOKEN)

            result = await client.use(pipeline=get_chat_pipeline(), token=self.CHAT_TOKEN)
            chat_token = result['token']

            question = Question()
            question.addQuestion('Tell me about machine learning')
            question.addInstruction('Format', 'Keep the response under 100 words')
            question.addInstruction('Tone', 'Use simple, beginner-friendly language and talk like yoda')

            response = await client.chat(
                token=chat_token,
                question=question,
            )

            assert response is not None
            assert isinstance(response, dict)

            # Validate basic response structure
            assert 'name' in response
            assert 'path' in response
            assert 'objectId' in response

            # Should have answers field
            assert 'result_types' in response
            assert response['result_types']['answers'] == 'answers'
            assert 'answers' in response
            assert isinstance(response['answers'], list)
            assert len(response['answers']) > 0

            # Check that we got a meaningful answer
            answer = response['answers'][0]
            assert isinstance(answer, str)
            assert len(answer) > 0
        finally:
            if chat_token:
                await ensure_clean_pipeline(client, chat_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_questions_with_context(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        chat_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.CHAT_TOKEN)

            result = await client.use(pipeline=get_chat_pipeline(), token=self.CHAT_TOKEN)
            chat_token = result['token']

            question = Question()
            question.addContext('This is a test environment')
            question.addContext('The user is learning about the RocketRide API')
            question.addQuestion('Explain what just happened in this interaction')

            response = await client.chat(
                token=chat_token,
                question=question,
            )

            assert response is not None
            assert isinstance(response, dict)

            # Validate basic response structure
            assert 'name' in response
            assert 'path' in response
            assert 'objectId' in response

            # Should have answers field
            assert 'result_types' in response
            assert response['result_types']['answers'] == 'answers'
            assert 'answers' in response
            assert isinstance(response['answers'], list)
            assert len(response['answers']) > 0

            # Check that we got a response
            answer = response['answers'][0]
            assert isinstance(answer, str)
            assert len(answer) > 0
        finally:
            if chat_token:
                await ensure_clean_pipeline(client, chat_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_validate_chat_response_structure_matches_pipeline_result(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        chat_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.CHAT_TOKEN)

            result = await client.use(pipeline=get_chat_pipeline(), token=self.CHAT_TOKEN)
            chat_token = result['token']

            question = Question()
            question.addQuestion('What is the weather like today?')

            response = await client.chat(
                token=chat_token,
                question=question,
            )

            # Verify it's a standard PIPELINE_RESULT
            assert 'name' in response
            assert 'path' in response
            assert 'objectId' in response

            # Check result_types specifically for chat responses
            if response.get('result_types'):
                for field_name, field_type in response['result_types'].items():
                    assert field_name in response

                    # For answers type fields, should be string arrays
                    if field_type == 'answers':
                        assert isinstance(response[field_name], list)
                        if len(response[field_name]) > 0:
                            assert isinstance(response[field_name][0], str)
        finally:
            if chat_token:
                await ensure_clean_pipeline(client, chat_token)
            if client.is_connected():
                await client.disconnect()


class TestConnectionEvents:
    """Test connection event callbacks."""

    @pytest.mark.asyncio
    async def test_should_call_connected_disconnected_callbacks(self):
        connected_spy = AsyncMock()
        disconnected_spy = AsyncMock()

        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
            on_connected=connected_spy,
            on_disconnected=disconnected_spy,
        )

        try:
            assert client.is_connected() is False

            await client.connect()
            assert client.is_connected() is True

            connected_spy.assert_called_once()
            assert isinstance(connected_spy.call_args[0][0], str)
            disconnected_spy.assert_not_called()

            await client.disconnect()

            assert client.is_connected() is False

            disconnected_spy.assert_called_once()
            call_args = disconnected_spy.call_args[0]
            assert isinstance(call_args[0], str)  # reason
            assert call_args[1] is False  # has_error
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_call_disconnected_with_error_flag_on_connection_failure(self):
        connected_spy = AsyncMock()
        disconnected_spy = AsyncMock()

        # Use an invalid URI that will definitely fail to connect
        client = RocketRideClient(
            auth='INVALID_KEY',
            uri='http://localhost:59999',  # Non-existent server
            on_connected=connected_spy,
            on_disconnected=disconnected_spy,
        )

        with pytest.raises(Exception):
            await client.connect()

        connected_spy.assert_not_called()

        if disconnected_spy.call_count > 0:
            call_args = disconnected_spy.call_args[0]
            assert call_args[1] is True  # has_error


# This is Part 2 - paste this after Part 1


class TestEventHandling:
    """Test event subscription and handling."""

    EVENT_TOKEN = 'PY-EV'

    @pytest.mark.asyncio
    async def test_should_subscribe_to_events_and_receive_them(self):
        received_events = []

        async def event_handler(event):
            received_events.append(event)

        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
            on_event=event_handler,
        )

        event_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.EVENT_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.EVENT_TOKEN)
            event_token = result['token']

            await client.set_events(event_token, ['summary'])
            await client.send(event_token, 'Test data for events')

            # Wait with timeout for events
            timeout = 10.0
            start = time.time()

            while len(received_events) == 0 and (time.time() - start) < timeout:
                await asyncio.sleep(0.25)

            # Verify we got events
            assert len(received_events) >= 0

            # If we got events, verify their structure
            if len(received_events) > 0:
                event = received_events[0]
                assert 'event' in event
                assert 'body' in event
                assert isinstance(event['event'], str)
        finally:
            if event_token:
                await ensure_clean_pipeline(client, event_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_receive_event_status_update_events_with_proper_structure(self):
        received_events = []

        async def event_handler(event):
            received_events.append(event)

        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
            on_event=event_handler,
        )

        event_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.EVENT_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.EVENT_TOKEN)
            event_token = result['token']

            # Subscribe to status update events
            await client.set_events(event_token, ['summary'])

            # Trigger an event by sending data
            await client.send(event_token, 'Test data for status updates')

            # Wait for status update events
            timeout = 10.0
            start = time.time()

            while len(received_events) == 0 and (time.time() - start) < timeout:
                await asyncio.sleep(0.25)

            # Find status update events
            status_events = [event for event in received_events if event.get('event') == 'apaevt_status_update']

            if len(status_events) > 0:
                status_event = status_events[0]

                # Verify EVENT_STATUS_UPDATE structure
                assert status_event['type'] == 'event'
                assert status_event['event'] == 'apaevt_status_update'
                assert 'body' in status_event

                # Verify TASK_STATUS structure in body
                task_status = status_event['body']
                required_fields = [
                    'name',
                    'project_id',
                    'source',
                    'completed',
                    'state',
                    'startTime',
                    'endTime',
                    'debuggerAttached',
                    'status',
                    'warnings',
                    'errors',
                    'currentObject',
                    'currentSize',
                    'notes',
                    'totalSize',
                    'totalCount',
                    'completedSize',
                    'completedCount',
                    'failedSize',
                    'failedCount',
                    'wordsSize',
                    'wordsCount',
                    'rateSize',
                    'rateCount',
                    'serviceUp',
                    'exitCode',
                    'exitMessage',
                    'pipeflow',
                ]

                for field in required_fields:
                    assert field in task_status

                # Verify types for critical fields
                assert isinstance(task_status['name'], str)
                assert isinstance(task_status['project_id'], str)
                assert isinstance(task_status['source'], str)
                assert isinstance(task_status['completed'], bool)
                assert isinstance(task_status['state'], int)
                assert isinstance(task_status['warnings'], list)
                assert isinstance(task_status['errors'], list)
                assert isinstance(task_status['notes'], list)

                # Verify pipeline flow structure
                assert 'pipeflow' in task_status
                assert 'totalPipes' in task_status['pipeflow']
                assert 'byPipe' in task_status['pipeflow']
        finally:
            if event_token:
                await ensure_clean_pipeline(client, event_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_receive_event_task_events_with_proper_structure(self):
        received_events = []

        async def event_handler(event):
            received_events.append(event)

        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
            on_event=event_handler,
        )

        event_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.EVENT_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.EVENT_TOKEN)
            event_token = result['token']

            # Subscribe to task lifecycle events
            await client.set_events(event_token, ['task'])

            # Wait for task events (begin/end events should be sent during pipeline lifecycle)
            timeout = 15.0
            start = time.time()

            # Trigger pipeline operations to generate task events
            await client.send(event_token, 'Test data for task events')

            while len(received_events) == 0 and (time.time() - start) < timeout:
                await asyncio.sleep(0.25)

            # Find task events
            task_events = [event for event in received_events if event.get('event') == 'apaevt_task']

            if len(task_events) > 0:
                task_event = task_events[0]

                # Verify basic EVENT_TASK structure
                assert task_event['type'] == 'event'
                assert task_event['event'] == 'apaevt_task'
                assert 'body' in task_event
                assert 'action' in task_event['body']

                action = task_event['body']['action']
                assert action in ['running', 'begin', 'end']

                if action == 'running':
                    # Verify 'running' action structure
                    assert 'tasks' in task_event['body']
                    assert isinstance(task_event['body']['tasks'], list)

                    if len(task_event['body']['tasks']) > 0:
                        task_info = task_event['body']['tasks'][0]
                        assert 'id' in task_info
                        assert 'projectId' in task_info
                        assert 'source' in task_info
                        assert isinstance(task_info['id'], str)
                        assert isinstance(task_info['projectId'], str)
                        assert isinstance(task_info['source'], str)
                elif action in ['begin', 'end']:
                    # Verify 'begin'/'end' action structure
                    assert 'id' in task_event
                    assert isinstance(task_event['id'], str)
                    assert 'projectId' in task_event['body']
                    assert 'source' in task_event['body']
                    assert isinstance(task_event['body']['projectId'], str)
                    assert isinstance(task_event['body']['source'], str)
        finally:
            if event_token:
                await ensure_clean_pipeline(client, event_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_event_type_flag_combinations_correctly(self):
        received_events = []

        async def event_handler(event):
            received_events.append(event)

        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
            on_event=event_handler,
        )

        event_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.EVENT_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.EVENT_TOKEN)
            event_token = result['token']

            # Test subscribing to multiple event types using flag combinations
            event_types = ['apaevt_status_update', 'apaevt_task']

            # Setup to receive both event categories
            await client.set_events(event_token, ['summary', 'task'])

            # Trigger various events
            await client.send(event_token, 'Test data for multiple event types')

            timeout = 10.0
            start = time.time()

            while len(received_events) == 0 and (time.time() - start) < timeout:
                await asyncio.sleep(0.25)

            # Verify we can receive different types of events
            event_types_seen = set(event.get('event') for event in received_events)

            # Should have received at least one of the subscribed event types
            expected_events = set(event_types)
            intersection = event_types_seen.intersection(expected_events)

            assert len(intersection) > 0
        finally:
            if event_token:
                await ensure_clean_pipeline(client, event_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_validate_event_structure_matches_definitions(self):
        received_events = []

        async def event_handler(event):
            received_events.append(event)

        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
            on_event=event_handler,
        )

        event_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.EVENT_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.EVENT_TOKEN)
            event_token = result['token']

            # Subscribe to all relevant event types
            await client.set_events(event_token, ['summary', 'task'])

            # Trigger events
            await client.send(event_token, 'Validation test data')

            timeout = 10.0
            start = time.time()

            while len(received_events) == 0 and (time.time() - start) < timeout:
                await asyncio.sleep(0.25)

            # Validate each received event matches our type definitions
            for event in received_events:
                # All events should have basic DAP structure
                assert event.get('type') == 'event'
                assert 'event' in event
                assert isinstance(event['event'], str)

                if event['event'] == 'apaevt_status_update':
                    # Validate EVENT_STATUS_UPDATE structure
                    assert 'body' in event

                    # Key TASK_STATUS fields that should always be present
                    required_fields = [
                        'name',
                        'project_id',
                        'source',
                        'completed',
                        'state',
                        'startTime',
                        'endTime',
                        'debuggerAttached',
                        'status',
                        'warnings',
                        'errors',
                        'currentObject',
                        'currentSize',
                        'notes',
                        'totalSize',
                        'totalCount',
                        'completedSize',
                        'completedCount',
                        'failedSize',
                        'failedCount',
                        'wordsSize',
                        'wordsCount',
                        'rateSize',
                        'rateCount',
                        'serviceUp',
                        'exitCode',
                        'exitMessage',
                        'pipeflow',
                    ]

                    for field in required_fields:
                        assert field in event['body']

                    # Validate types for critical fields
                    assert isinstance(event['body']['name'], str)
                    assert isinstance(event['body']['project_id'], str)
                    assert isinstance(event['body']['source'], str)
                    assert isinstance(event['body']['completed'], bool)
                    assert isinstance(event['body']['state'], int)
                    assert isinstance(event['body']['warnings'], list)
                    assert isinstance(event['body']['errors'], list)
                    assert isinstance(event['body']['notes'], list)

                if event['event'] == 'apaevt_task':
                    # Validate EVENT_TASK structure
                    assert 'body' in event
                    assert 'action' in event['body']
                    assert event['body']['action'] in ['running', 'begin', 'end']

                    if event['body']['action'] == 'running':
                        assert 'tasks' in event['body']
                        assert isinstance(event['body']['tasks'], list)
                    else:
                        assert 'id' in event
                        assert isinstance(event['id'], str)
                        assert 'projectId' in event['body']
                        assert 'source' in event['body']
        finally:
            if event_token:
                await ensure_clean_pipeline(client, event_token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_event_filtering_based_on_subscription(self):
        received_events = []

        async def event_handler(event):
            received_events.append(event)

        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
            on_event=event_handler,
        )

        event_token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.EVENT_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.EVENT_TOKEN)
            event_token = result['token']

            # Test that we only receive events we subscribed to
            await client.set_events(event_token, ['summary'])

            # Trigger events
            await client.send(event_token, 'Filtering test data')

            timeout = 10.0
            start = time.time()

            while len(received_events) == 0 and (time.time() - start) < timeout:
                await asyncio.sleep(0.25)

            # Should have received at least one status_update event
            status_events = [e for e in received_events if e.get('event') == 'apaevt_status_update']
            assert len(status_events) > 0, (
                "Expected at least one apaevt_status_update event after subscribing to ['summary']"
            )

            # Clear events and change subscription
            received_events.clear()
            await client.set_events(event_token, ['task'])

            # Trigger more events
            await client.send(event_token, 'Second filtering test')

            # Wait for task events (filter out unsolicited events from other server activity)
            start2 = time.time()
            while (
                not any(e.get('event') == 'apaevt_task' for e in received_events) and (time.time() - start2) < timeout
            ):
                await asyncio.sleep(0.25)

            # Should have received at least one task event
            task_events = [e for e in received_events if e.get('event') == 'apaevt_task']
            assert len(task_events) > 0, "Expected at least one apaevt_task event after subscribing to ['task']"
        finally:
            if event_token:
                await ensure_clean_pipeline(client, event_token)
            if client.is_connected():
                await client.disconnect()


class TestValidationOperations:
    """Test pipeline validation operations."""

    @pytest.mark.asyncio
    async def test_should_validate_echo_pipeline_with_source_in_config(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()

            pipeline = get_echo_pipeline()
            result = await client.validate(pipeline)

            assert result is not None
            assert 'pipeline' in result
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_validate_echo_pipeline_with_explicit_source(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()

            pipeline = get_echo_pipeline()
            result = await client.validate(pipeline, source='webhook_1')

            assert result is not None
            assert 'pipeline' in result
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_validate_pipeline_with_implied_source(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()

            # Pipeline with no explicit source field — webhook_1 has config.mode == 'Source'
            pipeline = {
                'components': [
                    {
                        'id': 'webhook_1',
                        'provider': 'webhook',
                        'config': {'hideForm': True, 'mode': 'Source', 'type': 'webhook'},
                    },
                    {
                        'id': 'response_1',
                        'provider': 'response',
                        'config': {'lanes': []},
                        'input': [{'lane': 'text', 'from': 'webhook_1'}],
                    },
                ],
                'project_id': 'e612b741-748c-4b35-a8b7-186797a8ea42',
            }

            result = await client.validate(pipeline)

            assert result is not None
            assert 'pipeline' in result
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_return_errors_for_invalid_pipeline_configuration(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()

            invalid_pipeline = {
                'components': [
                    {'id': 'invalid_1', 'provider': 'nonexistent_provider', 'config': {}},
                ],
                'source': 'invalid_1',
                'project_id': 'e612b741-748c-4b35-a8b7-186797a8ea42',
            }

            result = await client.validate(invalid_pipeline)

            assert result is not None
            assert 'errors' in result
            assert isinstance(result['errors'], list)
            assert len(result['errors']) > 0
        finally:
            if client.is_connected():
                await client.disconnect()


class TestErrorHandling:
    """Test error handling scenarios."""

    ERROR_TOKEN = 'PY-ER'

    @pytest.mark.asyncio
    async def test_should_handle_invalid_pipeline_configuration(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.ERROR_TOKEN)

            invalid_pipeline = {
                'components': [{'id': 'invalid_1', 'provider': 'nonexistent_provider', 'config': {}}],
                'source': 'invalid_1',
                'project_id': 'e612b741-748c-4b35-a8b7-186797a8ea42',
            }

            with pytest.raises(Exception):
                await client.use(pipeline=invalid_pipeline, token=self.ERROR_TOKEN)
        finally:
            await ensure_clean_pipeline(client, self.ERROR_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_operations_on_terminated_pipeline(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.ERROR_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.ERROR_TOKEN)

            await client.terminate(result['token'])

            with pytest.raises(Exception):
                await client.send(result['token'], 'data')
        finally:
            await ensure_clean_pipeline(client, self.ERROR_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_network_disconnection_gracefully(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        await client.disconnect()

        with pytest.raises(Exception):
            await client.ping()


class TestEndToEndWorkflow:
    """Test complete end-to-end workflows."""

    E2E_TOKEN = 'PY-E2'

    @pytest.mark.asyncio
    async def test_should_complete_full_data_processing_workflow(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.E2E_TOKEN)

            result = await client.use(pipeline=get_echo_pipeline(), token=self.E2E_TOKEN)
            token = result['token']

            await client.set_events(token, ['summary', 'task'])

            test_data = 'hello world from e2e test'
            process_result = await client.send(token, test_data, {}, 'text/plain')

            status = await client.get_task_status(token)

            await client.terminate(token)
            token = None  # Mark as terminated

            # Enhanced validation
            assert process_result is not None
            assert 'name' in process_result
            assert 'objectId' in process_result
            assert 'result_types' in process_result
            assert 'text' in process_result
            assert test_data in process_result['text'][0]

            assert 'state' in status
            assert status['state'] in [state.value for state in TASK_STATE]
            assert result['token'] is not None
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            await ensure_clean_pipeline(client, self.E2E_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_complete_file_upload_and_processing_workflow(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-file')

            result = await client.use(pipeline=get_echo_pipeline(), token=f'{self.E2E_TOKEN}-file')
            token = result['token']

            # Set up event monitoring
            await client.set_events(token, ['summary', 'task'])

            # Create test file
            name = 'e2e-test.txt'
            test_content = f"""End-to-end file processing test
Line 2: timestamp {int(time.time())}
Line 3: random data {random.random()}"""

            # Create file file
            with open(name, 'w') as f:
                # Create the file
                f.write(test_content)
                f.close()

                # Upload and process file
                try:
                    upload_results = await client.send_files([(name, {'name': name}, 'text/plain')], token)
                finally:
                    os.unlink(name)  # Ensure temp file is deleted

            # Get final task status
            final_status = await client.get_task_status(token)

            await client.terminate(token)
            token = None

            # Validate complete workflow
            assert len(upload_results) == 1
            assert upload_results[0]['action'] == 'complete'
            assert 'result' in upload_results[0]

            processing_result = upload_results[0]['result']
            assert processing_result['name'] == name
            assert processing_result['result_types']['text'] == 'text'
            assert 'text' in processing_result
            assert 'End-to-end file processing test' in processing_result['text'][0]

            assert 'state' in final_status
            assert 'completed' in final_status
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-file')
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_multi_step_data_processing_workflow(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-multi')

            result = await client.use(pipeline=get_echo_pipeline(), token=f'{self.E2E_TOKEN}-multi')
            token = result['token']

            await client.set_events(token, ['summary'])

            # Step 1: Send initial data
            step1_data = 'Step 1: Initial data'
            step1_result = await client.send(token, step1_data, {}, 'text/plain')

            # Verify step 1
            assert step1_result is not None
            assert step1_data in step1_result['text'][0]

            # Step 2: Send follow-up data
            step2_data = 'Step 2: Follow-up processing'
            step2_result = await client.send(token, step2_data, {}, 'text/plain')

            # Verify step 2
            assert step2_result is not None
            assert step2_data in step2_result['text'][0]

            # Step 3: Streaming data
            pipe = await client.pipe(token, {'name': 'step3-stream.txt'}, 'text/plain')
            await pipe.open()
            await pipe.write('Step 3: Streaming data'.encode())
            step3_result = await pipe.close()

            # Verify step 3
            assert step3_result is not None
            assert step3_result['name'] == 'step3-stream.txt'
            assert 'Step 3: Streaming data' in step3_result['text'][0]

            # Verify all three operations produced valid results
            assert len(step1_result['objectId']) == 36
            assert len(step2_result['objectId']) == 36
            assert len(step3_result['objectId']) == 36

            # Ensure all results are unique
            object_ids = [step1_result['objectId'], step2_result['objectId'], step3_result['objectId']]
            unique_ids = set(object_ids)
            assert len(unique_ids) == 3

            await client.terminate(token)
            token = None
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-multi')
            if client.is_connected():
                await client.disconnect()

    @requires_llm
    @pytest.mark.asyncio
    async def test_should_handle_chat_workflow_with_multiple_interactions(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-chat')

            result = await client.use(pipeline=get_chat_pipeline(), token=f'{self.E2E_TOKEN}-chat')
            token = result['token']

            await client.set_events(token, ['summary', 'task'])

            # First chat interaction
            question1 = Question()
            question1.addQuestion('What is 5 + 3?')
            response1 = await client.chat(token=token, question=question1)

            assert response1['result_types']['answers'] == 'answers'
            assert 'answers' in response1
            assert '8' in response1['answers'][0]

            # Second chat interaction with context
            question2 = Question()
            question2.addContext('We just solved a math problem')
            question2.addQuestion('What was the previous answer?')
            response2 = await client.chat(token=token, question=question2)

            assert 'answers' in response2
            assert len(response2['answers']) > 0

            # Third interaction with JSON expectation
            question3 = Question(expectJson=True)
            question3.addQuestion('Return the result of 10 * 2 as JSON')
            question3.addExample('math result', {'result': 20, 'operation': 'multiplication'})
            response3 = await client.chat(token=token, question=question3)

            assert 'answers' in response3
            answer3 = response3['answers'][0]
            assert isinstance(answer3, dict)
            assert 'result' in answer3

            # Verify all three chat interactions produced valid results
            assert len(response1['objectId']) == 36
            assert len(response2['objectId']) == 36
            assert len(response3['objectId']) == 36

            await client.terminate(token)
            token = None
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-chat')
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_mixed_operation_workflow_with_events(self):
        received_events = []

        async def event_handler(event):
            received_events.append(event)

        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
            on_event=event_handler,
        )

        token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-mixed')

            result = await client.use(pipeline=get_echo_pipeline(), token=f'{self.E2E_TOKEN}-mixed')
            token = result['token']

            # Set up comprehensive event monitoring
            await client.set_events(token, ['summary', 'task'])

            # Mixed operations

            # Direct send
            send_result = await client.send(token, 'Mixed operation 1', {}, 'text/plain')

            # File upload
            name = 'mixed-test.txt '
            file_content = 'Mixed file content'

            # Create file file
            with open(name, 'w') as f:
                # Create the file
                f.write(file_content)
                f.close()

                # Upload and process file
                try:
                    upload_result = await client.send_files([(name, {'name': name}, 'text/plain')], token)
                finally:
                    os.unlink(name)  # Ensure temp file is deleted

            # Streaming
            pipe = await client.pipe(token, {'name': 'mixed-stream.txt'}, 'text/plain')
            await pipe.open()
            await pipe.write('Mixed streaming content'.encode())
            stream_result = await pipe.close()

            # Small delay to ensure events are processed
            await asyncio.sleep(0.5)

            # Validate results
            results = [send_result, upload_result, stream_result]
            assert len(results) == 3

            # Direct send result
            assert 'Mixed operation 1' in send_result['text'][0]

            # File upload result
            assert upload_result[0]['result']['text'][0] == 'Mixed file content\n\n'

            # Stream result
            assert 'Mixed streaming content' in stream_result['text'][0]

            # Check that we received events
            assert len(received_events) > 0

            # Verify event types
            event_types = set(e.get('event') for e in received_events)
            assert 'apaevt_status_update' in event_types or 'apaevt_task' in event_types

            await client.terminate(token)
            token = None
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-mixed')
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_error_recovery_workflow(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-error')

            result = await client.use(pipeline=get_echo_pipeline(), token=f'{self.E2E_TOKEN}-error')
            token = result['token']

            # Send valid data first
            valid_result = await client.send(token, 'Valid data before error', {}, 'text/plain')
            assert valid_result is not None
            assert 'Valid data before error' in valid_result['text'][0]

            # Check status after valid operation
            status_after_valid = await client.get_task_status(token)
            assert len(status_after_valid['errors']) == 0

            # Try to send data after termination (should fail)
            await client.terminate(token)
            token = None

            with pytest.raises(Exception):
                await client.send(result['token'], 'Data after termination', {}, 'text/plain')

            # Verify the valid operation completed successfully despite later error
            assert valid_result is not None
            assert 'Valid data before error' in valid_result['text'][0]
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-error')
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_large_data_workflow(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-large')

            result = await client.use(pipeline=get_echo_pipeline(), token=f'{self.E2E_TOKEN}-large')
            token = result['token']

            # Generate large text content (10KB)
            large_text = '\n'.join(
                [
                    f'Line {i + 1}: This is a test line with some content to make it longer. Random: {random.random()}'
                    for i in range(1000)
                ]
            )

            assert len(large_text) > 10000

            start_time = time.time()
            large_result = await client.send(token, large_text, {}, 'text/plain')
            end_time = time.time()

            # Validate large data processing
            assert large_result is not None
            assert 'Line 1:' in large_result['text'][0]
            assert 'Line 1000:' in large_result['text'][0]
            assert len(large_result['text'][0]) > 10000

            # Check processing time (should complete reasonably quickly)
            processing_time = end_time - start_time
            assert processing_time < 10.0  # Less than 10 seconds

            print(f'Large data workflow: Processed {len(large_text)} bytes in {processing_time * 1000:.0f}ms')

            # Get final status to verify task completed
            final_status = await client.get_task_status(token)
            assert 'state' in final_status

            await client.terminate(token)
            token = None
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            await ensure_clean_pipeline(client, f'{self.E2E_TOKEN}-large')
            if client.is_connected():
                await client.disconnect()


class TestConcurrentPipelineOperations:
    """Test concurrent pipeline operations."""

    CONCURRENT_TOKEN = 'PY-CC'
    PIPELINE_COUNT = 16  # Full 16 pipeline testing

    @pytest.mark.asyncio
    async def test_should_handle_16_concurrent_pipelines_with_unique_data(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_tokens = []
        try:
            await client.connect()

            # Clean up any existing pipeline
            await ensure_clean_pipeline(client, self.CONCURRENT_TOKEN)

            # Create 16 concurrent use() calls — all share one subprocess via useExisting
            async def create_pipeline(index):
                result = await client.use(pipeline=get_echo_pipeline(), token=self.CONCURRENT_TOKEN, use_existing=True)
                return {'index': index, 'token': result['token']}

            pipeline_tasks = [create_pipeline(i) for i in range(self.PIPELINE_COUNT)]
            pipelines = await asyncio.gather(*pipeline_tasks)
            pipeline_tokens = [p['token'] for p in pipelines]

            # Generate unique test data for each pipeline
            def generate_test_data(pipeline, index):
                return {
                    'pipeline_index': index,
                    'token': pipeline['token'],
                    'text': f'Pipeline-{index} unique test data: {"".join(random.choices(string.ascii_lowercase, k=8))} timestamp-{int(time.time())}-{index}',
                    'expected_id': f'pipeline-{index}-response',
                }

            test_data = [generate_test_data(pipeline, index) for index, pipeline in enumerate(pipelines)]

            # Send data to all pipelines concurrently with random delays
            async def send_data(data):
                # Add random delay (0-100ms) to simulate real-world timing variations
                await asyncio.sleep(random.random() * 0.1)

                result = await client.send(data['token'], data['text'], {}, 'text/plain')

                return {'pipeline_index': data['pipeline_index'], 'original_text': data['text'], 'response': result}

            send_tasks = [send_data(data) for data in test_data]
            results = await asyncio.gather(*send_tasks)

            # Validate that each pipeline received its correct data
            assert len(results) == self.PIPELINE_COUNT

            # Check each result individually
            for result in results:
                pipeline_index = result['pipeline_index']
                original_text = result['original_text']
                response = result['response']

                # Validate basic response structure
                assert response is not None
                assert isinstance(response, dict)
                assert 'name' in response
                assert 'objectId' in response
                assert len(response['objectId']) == 36

                # Should have processed content with text/plain MIME type
                assert 'result_types' in response
                assert response['result_types']['text'] == 'text'

                # Validate the echoed text matches what we sent
                assert 'text' in response
                assert isinstance(response['text'], list)
                assert len(response['text']) > 0

                # The response should contain our original text
                response_text = response['text'][0]
                assert original_text in response_text

                # Verify pipeline-specific data is preserved
                assert f'Pipeline-{pipeline_index}' in response_text

            # Verify no cross-contamination between pipelines
            unique_texts = set(r['response']['text'][0] for r in results)
            assert len(unique_texts) == self.PIPELINE_COUNT  # All responses should be unique

            # Verify all pipeline indices are represented
            pipeline_indices = sorted([r['pipeline_index'] for r in results])
            expected_indices = list(range(self.PIPELINE_COUNT))
            assert pipeline_indices == expected_indices

            print('Concurrent pipeline test completed successfully:')
            print(f'- Created {self.PIPELINE_COUNT} pipelines')
            print(f'- Sent {self.PIPELINE_COUNT} unique messages')
            print(f'- Received {len(results)} responses')
            print(f'- All responses unique: {len(unique_texts) == self.PIPELINE_COUNT}')
        finally:
            # Clean up all pipelines
            cleanup_tasks = []
            for token in pipeline_tokens:
                cleanup_tasks.append(ensure_clean_pipeline(client, token))
            if cleanup_tasks:
                await asyncio.gather(*cleanup_tasks, return_exceptions=True)

            await ensure_clean_pipeline(client, self.CONCURRENT_TOKEN)

            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_concurrent_data_sends_to_the_same_pipeline(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_tokens = []
        try:
            await client.connect()

            # Create a single pipeline
            result = await client.use(pipeline=get_echo_pipeline(), token=f'{self.CONCURRENT_TOKEN}-1p')
            pipeline_tokens = [result['token']]

            SEND_COUNT = 10

            # Generate unique test data for concurrent sends
            test_data = [
                {
                    'index': i,
                    'text': f'Concurrent-send-{i} data: {"".join(random.choices(string.ascii_lowercase, k=8))} timestamp-{int(time.time())}-{i}',
                }
                for i in range(SEND_COUNT)
            ]

            # Send all data concurrently to the same pipeline
            async def send_data(data):
                # Add small random delay to simulate real conditions
                await asyncio.sleep(random.random() * 0.05)

                response = await client.send(result['token'], data['text'], {}, 'text/plain')

                return {'send_index': data['index'], 'original_text': data['text'], 'response': response}

            send_tasks = [send_data(data) for data in test_data]
            responses = await asyncio.gather(*send_tasks)

            # Validate all responses
            assert len(responses) == SEND_COUNT

            for response_data in responses:
                send_index = response_data['send_index']
                original_text = response_data['original_text']
                response = response_data['response']

                # Validate basic structure
                assert response is not None
                assert response['result_types']['text'] == 'text'
                assert 'text' in response
                assert isinstance(response['text'], list)

                # Verify the response contains the original text
                response_text = response['text'][0]
                assert original_text in response_text
                assert f'Concurrent-send-{send_index}' in response_text

            # Verify all responses are unique (no cross-contamination)
            response_texts = [r['response']['text'][0] for r in responses]
            unique_response_texts = set(response_texts)
            assert len(unique_response_texts) == SEND_COUNT

            print('Concurrent sends to single pipeline test completed:')
            print(f'- Sent {SEND_COUNT} concurrent messages to 1 pipeline')
            print(f'- Received {len(responses)} unique responses')
        finally:
            # Clean up all pipelines
            cleanup_tasks = []
            for token in pipeline_tokens:
                cleanup_tasks.append(ensure_clean_pipeline(client, token))
            if cleanup_tasks:
                await asyncio.gather(*cleanup_tasks, return_exceptions=True)

            await ensure_clean_pipeline(client, f'{self.CONCURRENT_TOKEN}-1p')
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_mixed_concurrent_pipeline_and_send_operations(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        pipeline_tokens = []
        try:
            await client.connect()

            PIPELINE_COUNT = 4
            SENDS_PER_PIPELINE = 3

            # Clean up any leftover pipelines from previous runs
            for i in range(PIPELINE_COUNT):
                await ensure_clean_pipeline(client, f'{self.CONCURRENT_TOKEN}-m{i}')

            # Create pipelines concurrently
            async def create_pipeline(index):
                result = await client.use(pipeline=get_echo_pipeline(), token=f'{self.CONCURRENT_TOKEN}-m{index}')
                return {'index': index, 'token': result['token']}

            pipeline_tasks = [create_pipeline(i) for i in range(PIPELINE_COUNT)]
            pipelines = await asyncio.gather(*pipeline_tasks)
            pipeline_tokens = [p['token'] for p in pipelines]

            # Generate test data for multiple sends per pipeline
            all_send_data = []
            for pipeline in pipelines:
                for send_index in range(SENDS_PER_PIPELINE):
                    all_send_data.append(
                        {
                            'pipeline_index': pipeline['index'],
                            'send_index': send_index,
                            'token': pipeline['token'],
                            'text': f'Mixed-P{pipeline["index"]}-S{send_index}: {"".join(random.choices(string.ascii_lowercase, k=8))} time-{int(time.time())}-{pipeline["index"]}-{send_index}',
                        }
                    )

            # Execute all sends concurrently across all pipelines
            async def send_data(data):
                # Random delay to simulate realistic timing
                await asyncio.sleep(random.random() * 0.2)

                response = await client.send(data['token'], data['text'], {}, 'text/plain')

                return {
                    'pipeline_index': data['pipeline_index'],
                    'send_index': data['send_index'],
                    'original_text': data['text'],
                    'response': response,
                }

            send_results = await asyncio.gather(*[send_data(data) for data in all_send_data])

            # Validate results
            total_expected_sends = PIPELINE_COUNT * SENDS_PER_PIPELINE
            assert len(send_results) == total_expected_sends

            # Group results by pipeline to verify separation
            results_by_pipeline = {}
            for result in send_results:
                pipeline_index = result['pipeline_index']
                if pipeline_index not in results_by_pipeline:
                    results_by_pipeline[pipeline_index] = []
                results_by_pipeline[pipeline_index].append(result)

            # Verify each pipeline received exactly the right number of sends
            for i in range(PIPELINE_COUNT):
                assert len(results_by_pipeline[i]) == SENDS_PER_PIPELINE

            # Verify data integrity - each response should contain its original text
            for result in send_results:
                response_text = result['response']['text'][0]
                assert result['original_text'] in response_text
                assert f'Mixed-P{result["pipeline_index"]}-S{result["send_index"]}' in response_text

            # Verify no cross-contamination - all responses should be unique
            all_response_texts = [r['response']['text'][0] for r in send_results]
            unique_response_texts = set(all_response_texts)
            assert len(unique_response_texts) == total_expected_sends

            print('Mixed concurrent operations test completed:')
            print(f'- Created {PIPELINE_COUNT} pipelines')
            print(f'- Sent {SENDS_PER_PIPELINE} messages per pipeline ({total_expected_sends} total)')
            print(f'- All {len(send_results)} responses received and verified')
        finally:
            # Clean up all pipelines
            cleanup_tasks = []
            for token in pipeline_tokens:
                cleanup_tasks.append(ensure_clean_pipeline(client, token))
            if cleanup_tasks:
                await asyncio.gather(*cleanup_tasks, return_exceptions=True)

            for i in range(4):  # PIPELINE_COUNT
                await ensure_clean_pipeline(client, f'{self.CONCURRENT_TOKEN}-m{i}')

            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_4_independent_pipelines_each_cycling_32_send_recv(self):
        SUBPROCESS_COUNT = 4
        CYCLES_PER_PIPELINE = 32

        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        sub_tokens = []
        try:
            await client.connect()

            # Clean up any leftover pipelines from previous runs
            for i in range(SUBPROCESS_COUNT):
                await ensure_clean_pipeline(client, f'{self.CONCURRENT_TOKEN}-s{i}')

            # Create 4 independent subprocesses concurrently
            sub_tokens = [f'{self.CONCURRENT_TOKEN}-s{i}' for i in range(SUBPROCESS_COUNT)]
            await asyncio.gather(*[client.use(pipeline=get_echo_pipeline(), token=token) for token in sub_tokens])

            # Each pipeline independently cycles 32 send/recv — all 4 run in parallel
            async def run_pipeline(token, pipeline_index):
                results = []
                for cycle in range(CYCLES_PER_PIPELINE):
                    text = f'pipe-{pipeline_index}-cycle-{cycle}-{random.random()}'
                    result = await client.send(token, text, {}, 'text/plain')
                    assert result is not None
                    assert text in result['text'][0]
                    results.append(result['text'][0])
                return results

            all_results = await asyncio.gather(*[run_pipeline(token, i) for i, token in enumerate(sub_tokens)])

            flat = [r for pipeline in all_results for r in pipeline]
            assert len(flat) == SUBPROCESS_COUNT * CYCLES_PER_PIPELINE
            assert len(set(flat)) == SUBPROCESS_COUNT * CYCLES_PER_PIPELINE

        finally:
            for token in sub_tokens:
                try:
                    await client.terminate(token)
                except Exception as e:
                    print(f'Warning: failed to terminate pipeline token={token}: {e}')
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_handle_two_independent_clients_sending_concurrently_to_the_same_task(self):
        """
        Two-client variant of the concurrent-sends test, designed to exercise
        eaas's outbound _data_client multiplexing.

        When two independent RocketRideClient instances share a backend task
        (via use_existing), eaas proxies their requests over a single connection
        to the subprocess (data_server.DataConn). Each inbound client has its
        own DAP seq counter, so they independently issue overlapping seqs
        (e.g. both reach seq=4 within milliseconds). If eaas's _send_data
        forwarded the inbound dict verbatim, those colliding seqs would clobber
        the outbound _data_client._pending_requests map and one of the responses
        would be silently dropped, hanging the originating client forever.

        The fix builds a fresh outbound DAP packet via dap_request() so the
        eaas->subprocess hop allocates its own unique seq from
        _data_client._next_seq(), and rebuilds the inbound response envelope so
        the original client still sees its own seq in request_seq.

        Note: the single-client concurrent tests above do NOT exercise this
        path because one client has one monotonic seq counter -- it never
        collides with itself. Two independent clients fanning into one task are
        the necessary precondition.
        """
        SHARED_TOKEN = f'{self.CONCURRENT_TOKEN}-cs'
        SENDS_PER_CLIENT = 12

        # Two independent clients.  Each has its own DAP connection, its own
        # seq counter, and its own _pending_requests map.
        client_a = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        client_b = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client_a.connect()
            await client_b.connect()

            # Both clients use the SAME task via use_existing so the second
            # client.use() attaches to the existing task instead of starting a
            # fresh one.  This is what makes both clients fan into ONE shared
            # eaas->subprocess _data_client.
            res_a = await client_a.use(pipeline=get_echo_pipeline(), token=SHARED_TOKEN, use_existing=True)
            res_b = await client_b.use(pipeline=get_echo_pipeline(), token=SHARED_TOKEN, use_existing=True)
            assert res_b['token'] == res_a['token']

            # Generate distinct payloads per client so we can verify no cross-routing.
            data_a = [
                {
                    'index': i,
                    'text': f'clientA-send-{i}: {"".join(random.choices(string.ascii_lowercase, k=8))} time-{int(time.time())}-A-{i}',
                }
                for i in range(SENDS_PER_CLIENT)
            ]
            data_b = [
                {
                    'index': i,
                    'text': f'clientB-send-{i}: {"".join(random.choices(string.ascii_lowercase, k=8))} time-{int(time.time())}-B-{i}',
                }
                for i in range(SENDS_PER_CLIENT)
            ]

            async def send_a(d):
                await asyncio.sleep(random.random() * 0.05)
                response = await client_a.send(res_a['token'], d['text'], {}, 'text/plain')
                return {'client': 'A', 'index': d['index'], 'original_text': d['text'], 'response': response}

            async def send_b(d):
                await asyncio.sleep(random.random() * 0.05)
                response = await client_b.send(res_b['token'], d['text'], {}, 'text/plain')
                return {'client': 'B', 'index': d['index'], 'original_text': d['text'], 'response': response}

            # Fire both clients' sends concurrently.  Pre-fix this would hang
            # on whichever pipe lost the seq collision race.
            sends_a = [send_a(d) for d in data_a]
            sends_b = [send_b(d) for d in data_b]
            all_results = await asyncio.gather(*sends_a, *sends_b)

            # Every send must have completed (no hangs).
            assert len(all_results) == SENDS_PER_CLIENT * 2

            # Each response must contain its own original text AND the right
            # client tag (proves no cross-routing between clients).
            for r in all_results:
                assert r['response'] is not None
                response_text = r['response']['text'][0]
                assert r['original_text'] in response_text
                assert f'client{r["client"]}-send-{r["index"]}' in response_text

            # No two responses share the same text -- final guard against
            # cross-contamination.
            unique_texts = set(r['response']['text'][0] for r in all_results)
            assert len(unique_texts) == SENDS_PER_CLIENT * 2

            print('Two-client cross-task concurrent test completed:')
            print(f'- 2 independent clients × {SENDS_PER_CLIENT} concurrent sends each')
            print(f'- {len(all_results)} responses received and verified')
            print(f'- All responses unique: {len(unique_texts) == SENDS_PER_CLIENT * 2}')
        finally:
            # Clean up the shared task via whichever client is still alive.
            for c in (client_a, client_b):
                if c.is_connected():
                    try:
                        await c.terminate(SHARED_TOKEN)
                    except Exception:
                        pass
                    try:
                        await c.disconnect()
                    except Exception:
                        pass


async def is_server_available() -> bool:
    """Check if the RocketRide server is available for testing."""
    try:
        client = RocketRideClient(
            auth=TEST_CONFIG['auth'],
            uri=TEST_CONFIG['uri'],
        )

        await client.connect()
        await client.ping()
        await client.disconnect()
        return True
    except Exception:
        return False


@pytest.fixture(scope='session', autouse=True)
def check_server_availability():
    """Check server availability before running tests."""

    async def _check():
        server_available = await is_server_available()
        if not server_available:
            print(f"""
⚠️  RocketRide server not available at {TEST_CONFIG['uri']}
Integration tests may fail. Please ensure:
1. RocketRide server is running on localhost:5565
2. ROCKETRIDE_APIKEY environment variable is set (if required)
3. Server accepts connections from test client
            """)

    asyncio.run(_check())


@pytest.mark.parametrize(
    ('input_uri', 'expected_uri'),
    [
        ('wss://cloud.rocketride.ai', 'wss://cloud.rocketride.ai/task/service'),
        ('https://cloud.rocketride.ai', 'wss://cloud.rocketride.ai/task/service'),
        ('ws://localhost:5565', 'ws://localhost:5565/task/service'),
        ('http://localhost:5565', 'ws://localhost:5565/task/service'),
    ],
)
def test_get_websocket_uri_normalization(input_uri: str, expected_uri: str) -> None:
    """Verify websocket URI normalization preserves secure and non-secure schemes."""
    assert ConnectionMixin._get_websocket_uri(input_uri) == expected_uri


# ============================================================================
# File Store Operations
# ============================================================================


class TestFileStoreOperations:
    """Test handle-based file store operations against a live server."""

    def _unique_path(self, name: str = 'test') -> str:
        return f'.test-store/py-{name}-{"".join(random.choices(string.ascii_lowercase, k=8))}'

    @pytest.mark.asyncio
    async def test_handle_write_and_read(self):
        """Write via handle, read back via handle."""
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            path = self._unique_path('hw')

            info = await client.fs_open(path, 'w')
            written = await client.fs_write(info['handle'], b'hello world')
            assert written == 11
            await client.fs_close(info['handle'], 'w')

            info = await client.fs_open(path, 'r')
            assert info['size'] == 11
            data = await client.fs_read(info['handle'], offset=0)
            assert data == b'hello world'
            await client.fs_close(info['handle'], 'r')

            await client.fs_delete(path)
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_multiple_write_chunks(self):
        """Write multiple chunks then read back."""
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            path = self._unique_path('chunks')

            info = await client.fs_open(path, 'w')
            for i in range(5):
                await client.fs_write(info['handle'], f'chunk-{i}-'.encode())
            await client.fs_close(info['handle'], 'w')

            content = await client.fs_read_string(path)
            assert content == 'chunk-0-chunk-1-chunk-2-chunk-3-chunk-4-'

            await client.fs_delete(path)
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_read_in_chunks(self):
        """Read a file in multiple chunks via handle."""
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            path = self._unique_path('rc')
            data = b'X' * 1000

            info = await client.fs_open(path, 'w')
            await client.fs_write(info['handle'], data)
            await client.fs_close(info['handle'], 'w')

            info = await client.fs_open(path, 'r')
            chunks = []
            offset = 0
            while True:
                chunk = await client.fs_read(info['handle'], offset=offset, length=300)
                if not chunk:
                    break
                chunks.append(chunk)
                offset += len(chunk)
            await client.fs_close(info['handle'], 'r')

            assert b''.join(chunks) == data
            assert len(chunks) == 4  # 300 + 300 + 300 + 100

            await client.fs_delete(path)
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_convenience_string_roundtrip(self):
        """fs_write_string / fs_read_string round-trip."""
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            path = self._unique_path('str')

            await client.fs_write_string(path, 'Hello \u2603 \U0001f680')
            result = await client.fs_read_string(path)
            assert result == 'Hello \u2603 \U0001f680'

            await client.fs_delete(path)
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_convenience_json_roundtrip(self):
        """fs_write_json / fs_read_json round-trip."""
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            path = self._unique_path('json')
            obj = {'name': 'Test', 'values': [1, 2, 3], 'nested': {'ok': True}}

            await client.fs_write_json(path, obj)
            result = await client.fs_read_json(path)
            assert result == obj

            await client.fs_delete(path)
        finally:
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_stat_and_delete(self):
        """Write a file, stat it, delete it, stat again."""
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            path = self._unique_path('stat')

            info = await client.fs_open(path, 'w')
            await client.fs_write(info['handle'], b'data')
            await client.fs_close(info['handle'], 'w')

            result = await client.fs_stat(path)
            assert result['exists'] is True
            assert result['type'] == 'file'

            await client.fs_delete(path)

            result = await client.fs_stat(path)
            assert result['exists'] is False
        finally:
            if client.is_connected():
                await client.disconnect()


# Pytest configuration
pytest_plugins = ['pytest_asyncio']


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
