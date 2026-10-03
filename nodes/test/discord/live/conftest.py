# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Fixtures for the live Discord layer.

The whole directory is gated on ``DISCORD_LIVE=1`` so the normal
``nodes:test`` run collects these tests and skips them without touching the
network.
"""

import os

import pytest

from .live_support import (  # noqa: F401 — live_bot is a re-exported fixture
    LIVE_ENV_FLAG,
    DriverBot,
    EngineSession,
    driver_token_available,
    engine_reachable,
    live_bot,
    load_engine_config,
)


@pytest.fixture(scope='session')
def engine_config():
    """L3 ids (engine, guild, channel, driver bot) — never a token value."""
    config = load_engine_config()
    missing = [key for key in ('engineUri', 'supportChannelId', 'driverBotId') if not config[key]]
    if missing:
        pytest.skip(f'engine config incomplete: {", ".join(missing)}')
    if not engine_reachable(config['engineUri']):
        pytest.skip(f'engine not reachable on {config["engineUri"]}')
    if not driver_token_available(config):
        pytest.skip('driver bot token not readable (driverTokenEnvFile / driverTokenEnvKey)')
    return config


@pytest.fixture(scope='session')
def driver_bot(engine_config):
    """One connected driver identity per session; sweeps its own messages."""
    driver = DriverBot(engine_config).start()
    try:
        yield driver
    finally:
        residue = driver.cleanup()
        print('\n--- driver cleanup ---')
        print(f'deleted {driver.deleted} driver message(s)')
        for line in residue:
            print(f'residue: {line}')
        driver.close()


@pytest.fixture(scope='module')
def engine(engine_config):
    """One engine client per module; whatever task it started is terminated."""
    session = EngineSession(engine_config['engineUri'], engine_config['engineApiKey']).start()
    try:
        yield session
    finally:
        session.close()


def pytest_collection_modifyitems(config, items):
    """Skip every test in this directory unless DISCORD_LIVE=1."""
    if os.environ.get(LIVE_ENV_FLAG) == '1':
        return
    here = os.path.dirname(os.path.abspath(__file__))
    skip = pytest.mark.skip(reason=f'{LIVE_ENV_FLAG}=1 not set (live Discord tests post to a real server)')
    for item in items:
        if os.path.abspath(str(getattr(item, 'fspath', ''))).startswith(here):
            item.add_marker(skip)
