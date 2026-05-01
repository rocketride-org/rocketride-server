import pytest

from rocketride.mixins.connection import ConnectionMixin


@pytest.mark.parametrize(
    ('input_uri', 'expected_uri'),
    [
        ('https://cloud.rocketride.ai', 'wss://cloud.rocketride.ai/task/service'),
        ('https://cloud.rocketride.ai/', 'wss://cloud.rocketride.ai/task/service'),
        ('wss://cloud.rocketride.ai/task/service', 'wss://cloud.rocketride.ai/task/service'),
        ('ws://localhost:5565', 'ws://localhost:5565/task/service'),
        ('ws://localhost:5565/', 'ws://localhost:5565/task/service'),
        ('ws://localhost:5565/task/service', 'ws://localhost:5565/task/service'),
    ],
)
def test_get_websocket_uri_normalizes_task_service_path(input_uri, expected_uri):
    assert ConnectionMixin._get_websocket_uri(input_uri) == expected_uri
