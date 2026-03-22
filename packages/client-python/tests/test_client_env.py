from pathlib import Path

from rocketride import RocketRideClient


def test_client_uses_process_environment(monkeypatch, tmp_path: Path) -> None:
    """Use non-empty process env values for connection bootstrap."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('ROCKETRIDE_URI', 'https://env.example.com')
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'env-key')
    monkeypatch.delenv('ROCKETRIDE_AUTH', raising=False)

    client = RocketRideClient()

    assert client.get_connection_info()['uri'] == 'wss://env.example.com:5565/task/service'
    assert client.get_apikey() == 'env-key'


def test_client_uses_dotenv_when_process_environment_is_missing(monkeypatch, tmp_path: Path) -> None:
    """Fall back to `.env` when process env is absent."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv('ROCKETRIDE_URI', raising=False)
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)
    monkeypatch.delenv('ROCKETRIDE_AUTH', raising=False)
    (tmp_path / '.env').write_text(
        'ROCKETRIDE_URI=https://dotenv.example.com\nROCKETRIDE_APIKEY=dotenv-key\n',
        encoding='utf-8',
    )

    client = RocketRideClient()

    assert client.get_connection_info()['uri'] == 'wss://dotenv.example.com:5565/task/service'
    assert client.get_apikey() == 'dotenv-key'


def test_process_environment_takes_precedence_over_dotenv(monkeypatch, tmp_path: Path) -> None:
    """Prefer non-empty process env values over `.env`."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('ROCKETRIDE_URI', 'https://env.example.com')
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'env-key')
    (tmp_path / '.env').write_text(
        'ROCKETRIDE_URI=https://dotenv.example.com\nROCKETRIDE_APIKEY=dotenv-key\n',
        encoding='utf-8',
    )

    client = RocketRideClient()

    assert client.get_connection_info()['uri'] == 'wss://env.example.com:5565/task/service'
    assert client.get_apikey() == 'env-key'


def test_blank_process_environment_falls_back_to_dotenv(monkeypatch, tmp_path: Path) -> None:
    """Treat blank process env values as missing and use `.env` instead."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('ROCKETRIDE_URI', '')
    monkeypatch.setenv('ROCKETRIDE_APIKEY', '')
    (tmp_path / '.env').write_text(
        'ROCKETRIDE_URI=https://dotenv.example.com\nROCKETRIDE_APIKEY=dotenv-key\n',
        encoding='utf-8',
    )

    client = RocketRideClient()

    assert client.get_connection_info()['uri'] == 'wss://dotenv.example.com:5565/task/service'
    assert client.get_apikey() == 'dotenv-key'


def test_explicit_args_override_env_and_dotenv(monkeypatch, tmp_path: Path) -> None:
    """Keep explicit constructor args highest priority."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('ROCKETRIDE_URI', 'https://env.example.com')
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'env-key')
    (tmp_path / '.env').write_text(
        'ROCKETRIDE_URI=https://dotenv.example.com\nROCKETRIDE_APIKEY=dotenv-key\n',
        encoding='utf-8',
    )

    client = RocketRideClient(uri='https://explicit.example.com', auth='explicit-key')

    assert client.get_connection_info()['uri'] == 'wss://explicit.example.com:5565/task/service'
    assert client.get_apikey() == 'explicit-key'


def test_pipeline_env_substitution_still_uses_dotenv_values(monkeypatch, tmp_path: Path) -> None:
    """Preserve the prior `.env`-driven substitution behavior."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'env-key')
    (tmp_path / '.env').write_text('ROCKETRIDE_APIKEY=dotenv-key\n', encoding='utf-8')

    client = RocketRideClient()

    assert client._process_env_substitution('${ROCKETRIDE_APIKEY}') == 'dotenv-key'
