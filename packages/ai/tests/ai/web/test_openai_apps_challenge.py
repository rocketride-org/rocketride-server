# Copyright 2026 Aparavi Software AG. MIT License.
"""The OpenAI apps challenge route handler."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ai.web import openai_apps_challenge
from ai.web.openai_apps_challenge import CHALLENGE_PATH, ENV_CHALLENGE_TOKEN


@pytest.fixture(autouse=True)
def _no_token(monkeypatch):
    monkeypatch.delenv(ENV_CHALLENGE_TOKEN, raising=False)


@pytest.fixture
def client():
    app = FastAPI()
    app.add_api_route(CHALLENGE_PATH, openai_apps_challenge.openai_apps_challenge, methods=['GET'])
    return TestClient(app)


def test_route_returns_404_when_token_unset(client):
    response = client.get(CHALLENGE_PATH)

    assert response.status_code == 404
    assert response.headers['cache-control'] == 'no-store'


def test_route_returns_404_when_token_blank(client, monkeypatch):
    monkeypatch.setenv(ENV_CHALLENGE_TOKEN, '  \n')

    assert client.get(CHALLENGE_PATH).status_code == 404


def test_route_returns_exact_token_as_plain_text(client, monkeypatch):
    monkeypatch.setenv(ENV_CHALLENGE_TOKEN, 'abc123')

    response = client.get(CHALLENGE_PATH)

    assert response.status_code == 200
    assert response.content == b'abc123'
    assert response.headers['content-type'].startswith('text/plain')
    assert response.headers['cache-control'] == 'no-store'


def test_route_strips_surrounding_whitespace(client, monkeypatch):
    monkeypatch.setenv(ENV_CHALLENGE_TOKEN, ' abc123\n')

    assert client.get(CHALLENGE_PATH).content == b'abc123'


def test_register_routes_mounts_public_get():
    calls = []

    class _Server:
        def add_route(self, path, handler, methods, public=False):
            calls.append((path, methods, public))

    assert openai_apps_challenge.register_routes(_Server()) == CHALLENGE_PATH
    assert calls == [(CHALLENGE_PATH, ['GET'], True)]
