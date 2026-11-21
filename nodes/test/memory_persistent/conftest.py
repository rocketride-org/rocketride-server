# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Fixtures for the memory_persistent tests: a binding's ``self.state`` over the real server handlers.

The state backend keeps sessions in ``self.state``; the fixture admits one
binding on the two-replica harness's server (the real node-door handlers
over an in-process state store), so the tests run against the server's own
time-to-live cap and key limit rather than a stand-in.
"""

from __future__ import annotations

import uuid

import pytest
from rocketlib.doors import NodeState

from ..framework.replicas import Owner, ReplicaServer

#: The component id the pipeline gives the node; the server keys its state by it.
NODE_ID = 'memory_1'


@pytest.fixture
def state():
    """One binding's state door for one memory_persistent node, owned by one user, for the duration of a test."""
    with ReplicaServer() as server:
        engine = server.engine()
        binding = uuid.uuid4().hex
        server.admit(engine, binding, Owner(orgId='org-a', userId='alice'))
        token = server.serving(engine)
        try:
            yield NodeState(binding, NODE_ID)
        finally:
            server.done(token)
            server.end(engine, binding)
