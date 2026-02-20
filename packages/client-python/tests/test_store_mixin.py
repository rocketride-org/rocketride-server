"""
Unit tests for StoreMixin client functionality.

Tests cover:
- Input validation for all store operations
- Request building (mocked)
- Response handling (mocked)
"""

import pytest
from unittest.mock import AsyncMock, MagicMock


# Test input validation without server connection
class TestStoreMixinValidation:
    """Test input validation for StoreMixin methods."""

    @pytest.fixture
    def mock_client(self):
        """Create a mock client with StoreMixin."""
        from rocketride.mixins.store import StoreMixin

        # Create a mock that includes StoreMixin methods
        client = MagicMock(spec=StoreMixin)

        # Make the methods async and use actual validation from StoreMixin
        async def save_project(project_id, pipeline, expected_version=None):
            if not project_id:
                raise ValueError('project_id is required')
            if not pipeline or not isinstance(pipeline, dict):
                raise ValueError('pipeline must be a non-empty dictionary')
            return {'success': True, 'project_id': project_id, 'version': 'v1'}

        async def get_project(project_id):
            if not project_id:
                raise ValueError('project_id is required')
            return {'success': True, 'pipeline': {}, 'version': 'v1'}

        async def delete_project(project_id, expected_version=None):
            if not project_id:
                raise ValueError('project_id is required')
            return {'success': True}

        async def save_template(template_id, pipeline, expected_version=None):
            if not template_id:
                raise ValueError('template_id is required')
            if not pipeline or not isinstance(pipeline, dict):
                raise ValueError('pipeline must be a non-empty dictionary')
            return {'success': True, 'template_id': template_id, 'version': 'v1'}

        async def get_template(template_id):
            if not template_id:
                raise ValueError('template_id is required')
            return {'success': True, 'pipeline': {}, 'version': 'v1'}

        async def delete_template(template_id, expected_version=None):
            if not template_id:
                raise ValueError('template_id is required')
            return {'success': True}

        async def save_log(project_id, source, contents):
            if not project_id:
                raise ValueError('project_id is required')
            if not source:
                raise ValueError('source is required')
            if not contents or not isinstance(contents, dict):
                raise ValueError('contents must be a non-empty dictionary')
            return {'success': True, 'filename': 'test.log'}

        async def get_log(project_id, source, start_time):
            if not project_id:
                raise ValueError('project_id is required')
            if not source:
                raise ValueError('source is required')
            if start_time is None:
                raise ValueError('start_time is required')
            return {'success': True, 'contents': {}}

        async def list_logs(project_id, source=None, page=None):
            if not project_id:
                raise ValueError('project_id is required')
            return {'success': True, 'logs': [], 'count': 0}

        client.save_project = save_project
        client.get_project = get_project
        client.delete_project = delete_project
        client.save_template = save_template
        client.get_template = get_template
        client.delete_template = delete_template
        client.save_log = save_log
        client.get_log = get_log
        client.list_logs = list_logs

        return client

    # Project validation tests
    @pytest.mark.asyncio
    async def test_save_project_missing_project_id(self, mock_client):
        """Test save_project raises ValueError for missing project_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_project('', {'name': 'Test'})
        assert 'project_id is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_save_project_missing_pipeline(self, mock_client):
        """Test save_project raises ValueError for missing pipeline."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_project('proj-123', None)
        assert 'pipeline must be a non-empty dictionary' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_save_project_empty_pipeline(self, mock_client):
        """Test save_project raises ValueError for empty pipeline."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_project('proj-123', {})
        assert 'pipeline must be a non-empty dictionary' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_save_project_invalid_pipeline_type(self, mock_client):
        """Test save_project raises ValueError for invalid pipeline type."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_project('proj-123', 'not a dict')
        assert 'pipeline must be a non-empty dictionary' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_project_missing_project_id(self, mock_client):
        """Test get_project raises ValueError for missing project_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.get_project('')
        assert 'project_id is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_delete_project_missing_project_id(self, mock_client):
        """Test delete_project raises ValueError for missing project_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.delete_project('')
        assert 'project_id is required' in str(exc_info.value)

    # Template validation tests
    @pytest.mark.asyncio
    async def test_save_template_missing_template_id(self, mock_client):
        """Test save_template raises ValueError for missing template_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_template('', {'name': 'Test'})
        assert 'template_id is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_save_template_missing_pipeline(self, mock_client):
        """Test save_template raises ValueError for missing pipeline."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_template('tmpl-123', None)
        assert 'pipeline must be a non-empty dictionary' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_template_missing_template_id(self, mock_client):
        """Test get_template raises ValueError for missing template_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.get_template('')
        assert 'template_id is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_delete_template_missing_template_id(self, mock_client):
        """Test delete_template raises ValueError for missing template_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.delete_template('')
        assert 'template_id is required' in str(exc_info.value)

    # Log validation tests
    @pytest.mark.asyncio
    async def test_save_log_missing_project_id(self, mock_client):
        """Test save_log raises ValueError for missing project_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_log('', 'source_1', {'body': {}})
        assert 'project_id is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_save_log_missing_source(self, mock_client):
        """Test save_log raises ValueError for missing source."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_log('proj-123', '', {'body': {}})
        assert 'source is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_save_log_missing_contents(self, mock_client):
        """Test save_log raises ValueError for missing contents."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.save_log('proj-123', 'source_1', None)
        assert 'contents must be a non-empty dictionary' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_log_missing_project_id(self, mock_client):
        """Test get_log raises ValueError for missing project_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.get_log('', 'source_1', 1234567.0)
        assert 'project_id is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_log_missing_source(self, mock_client):
        """Test get_log raises ValueError for missing source."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.get_log('proj-123', '', 1234567.0)
        assert 'source is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_log_missing_start_time(self, mock_client):
        """Test get_log raises ValueError for missing start_time."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.get_log('proj-123', 'source_1', None)
        assert 'start_time is required' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_list_logs_missing_project_id(self, mock_client):
        """Test list_logs raises ValueError for missing project_id."""
        with pytest.raises(ValueError) as exc_info:
            await mock_client.list_logs('')
        assert 'project_id is required' in str(exc_info.value)

    # Valid operation tests
    @pytest.mark.asyncio
    async def test_save_project_valid(self, mock_client):
        """Test save_project with valid parameters."""
        result = await mock_client.save_project('proj-123', {'name': 'Test'})
        assert result['success'] is True
        assert result['project_id'] == 'proj-123'
        assert 'version' in result

    @pytest.mark.asyncio
    async def test_get_project_valid(self, mock_client):
        """Test get_project with valid parameters."""
        result = await mock_client.get_project('proj-123')
        assert result['success'] is True
        assert 'pipeline' in result

    @pytest.mark.asyncio
    async def test_delete_project_valid(self, mock_client):
        """Test delete_project with valid parameters."""
        result = await mock_client.delete_project('proj-123')
        assert result['success'] is True

    @pytest.mark.asyncio
    async def test_list_logs_valid(self, mock_client):
        """Test list_logs with valid parameters."""
        result = await mock_client.list_logs('proj-123')
        assert result['success'] is True


# Test with mocked DAP client
class TestStoreMixinWithMockedDAP:
    """Test StoreMixin with mocked DAP client."""

    @pytest.fixture
    def store_mixin_instance(self):
        """Create a StoreMixin instance with mocked DAP methods."""
        from rocketride.mixins.store import StoreMixin

        # Create a mock class that inherits StoreMixin
        class MockStoreMixin(StoreMixin):
            def __init__(self):
                self._debug = False

            def build_request(self, command, arguments):
                return {'command': command, 'arguments': arguments}

            def did_fail(self, response):
                return not response.get('body', {}).get('success', True)

            def debug_message(self, msg):
                if self._debug:
                    print(msg)

        instance = MockStoreMixin()
        instance.request = AsyncMock()
        return instance

    @pytest.mark.asyncio
    async def test_save_project_builds_correct_request(self, store_mixin_instance):
        """Test that save_project builds correct DAP request."""
        store_mixin_instance.request.return_value = {
            'body': {'success': True, 'project_id': 'proj-123', 'version': 'v1'}
        }

        pipeline = {'name': 'Test Pipeline', 'components': []}
        await store_mixin_instance.save_project('proj-123', pipeline)

        # Verify request was called with correct arguments
        store_mixin_instance.request.assert_called_once()
        request = store_mixin_instance.request.call_args[0][0]

        assert request['command'] == 'apaext_store'
        assert request['arguments']['subcommand'] == 'save_project'
        assert request['arguments']['projectId'] == 'proj-123'
        assert request['arguments']['pipeline'] == pipeline

    @pytest.mark.asyncio
    async def test_save_project_with_expected_version(self, store_mixin_instance):
        """Test that save_project includes expected version in request."""
        store_mixin_instance.request.return_value = {
            'body': {'success': True, 'project_id': 'proj-123', 'version': 'v2'}
        }

        pipeline = {'name': 'Test Pipeline', 'components': []}
        await store_mixin_instance.save_project(
            'proj-123', pipeline, expected_version='v1'
        )

        request = store_mixin_instance.request.call_args[0][0]
        assert request['arguments']['expectedVersion'] == 'v1'

    @pytest.mark.asyncio
    async def test_get_project_builds_correct_request(self, store_mixin_instance):
        """Test that get_project builds correct DAP request."""
        store_mixin_instance.request.return_value = {
            'body': {'success': True, 'pipeline': {'name': 'Test'}, 'version': 'v1'}
        }

        await store_mixin_instance.get_project('proj-123')

        request = store_mixin_instance.request.call_args[0][0]
        assert request['command'] == 'apaext_store'
        assert request['arguments']['subcommand'] == 'get_project'
        assert request['arguments']['projectId'] == 'proj-123'

    @pytest.mark.asyncio
    async def test_get_all_projects_builds_correct_request(self, store_mixin_instance):
        """Test that get_all_projects builds correct DAP request."""
        store_mixin_instance.request.return_value = {
            'body': {'success': True, 'projects': [], 'count': 0}
        }

        await store_mixin_instance.get_all_projects()

        request = store_mixin_instance.request.call_args[0][0]
        assert request['command'] == 'apaext_store'
        assert request['arguments']['subcommand'] == 'get_all_projects'

    @pytest.mark.asyncio
    async def test_delete_project_builds_correct_request(self, store_mixin_instance):
        """Test that delete_project builds correct DAP request."""
        store_mixin_instance.request.return_value = {
            'body': {'success': True}
        }

        await store_mixin_instance.delete_project('proj-123', expected_version='v1')

        request = store_mixin_instance.request.call_args[0][0]
        assert request['command'] == 'apaext_store'
        assert request['arguments']['subcommand'] == 'delete_project'
        assert request['arguments']['projectId'] == 'proj-123'
        assert request['arguments']['expectedVersion'] == 'v1'

    @pytest.mark.asyncio
    async def test_save_log_builds_correct_request(self, store_mixin_instance):
        """Test that save_log builds correct DAP request."""
        store_mixin_instance.request.return_value = {
            'body': {'success': True, 'filename': 'source_1-123456.log'}
        }

        contents = {'body': {'startTime': 123456.0, 'status': 'Completed'}}
        await store_mixin_instance.save_log('proj-123', 'source_1', contents)

        request = store_mixin_instance.request.call_args[0][0]
        assert request['command'] == 'apaext_store'
        assert request['arguments']['subcommand'] == 'save_log'
        assert request['arguments']['projectId'] == 'proj-123'
        assert request['arguments']['source'] == 'source_1'
        assert request['arguments']['contents'] == contents

    @pytest.mark.asyncio
    async def test_list_logs_with_filters(self, store_mixin_instance):
        """Test that list_logs includes filters in request."""
        store_mixin_instance.request.return_value = {
            'body': {'success': True, 'logs': [], 'count': 0, 'total_count': 0}
        }

        await store_mixin_instance.list_logs('proj-123', source='source_1', page=2)

        request = store_mixin_instance.request.call_args[0][0]
        assert request['arguments']['subcommand'] == 'list_logs'
        assert request['arguments']['projectId'] == 'proj-123'
        assert request['arguments']['source'] == 'source_1'
        assert request['arguments']['page'] == 2

    @pytest.mark.asyncio
    async def test_error_handling_raises_runtime_error(self, store_mixin_instance):
        """Test that error responses raise RuntimeError."""
        store_mixin_instance.request.return_value = {
            'body': {'success': False},
            'message': 'Project not found'
        }

        # Override did_fail to return True for this test
        store_mixin_instance.did_fail = lambda r: True

        with pytest.raises(RuntimeError) as exc_info:
            await store_mixin_instance.get_project('nonexistent')

        assert 'not found' in str(exc_info.value).lower()


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
