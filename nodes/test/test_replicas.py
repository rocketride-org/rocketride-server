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
The two-replica harness tests itself (plan 4.3) on two fixture nodes.

A counter kept on the IGlobal is the bug the harness exists for: per replica
and swept, it answers differently as the balancer alternates. The same counter
in ``self.state`` answers the same on any replica, and one owner's count never
moves another's.
"""

import textwrap

import pytest
import rocketlib.doors

from .framework.replicas import Call, Owner, Replica, ReplicaServer, run, run_alternating_and_alone

# ==== Fixture nodes ==============================================================

_IGLOBAL = """
from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    def beginGlobal(self):
        self.count = 0
"""

#: Keeps the count on the IGlobal: per replica, so wrong under a balancer.
_ON_THE_GLOBAL = """
from rocketlib import IInstanceBase


class IInstance(IInstanceBase):
    def writeText(self, text):
        self.IGlobal.count += 1
        self.instance.writeText(str(self.IGlobal.count))
        return self.preventDefault()
"""

#: Keeps the count in self.state: the server's, the same on every replica.
_IN_STATE = """
from rocketlib import IInstanceBase


class IInstance(IInstanceBase):
    def writeText(self, text):
        self.instance.writeText(str(self.state.incr('count')))
        return self.preventDefault()
"""


#: Keeps the count in a file through self.files: the server's too.
_IN_A_FILE = """
from rocketlib import DoorError, IInstanceBase


class IInstance(IInstanceBase):
    def writeText(self, text):
        try:
            count = self.files.get_json('count.json') + 1
        except DoorError:
            count = 1
        self.files.put_json('count.json', count)
        self.instance.writeText(str(count))
        return self.preventDefault()
"""

#: Records every endGlobal in a module-level list the test reads.
_ENDS = """
from rocketlib import IGlobalBase

ENDED = []


class IGlobal(IGlobalBase):
    def beginGlobal(self):
        self.count = 0

    def endGlobal(self):
        ENDED.append(self.glb.controlId)
"""


def _node(tmp_path, name, instance_source, global_source=_IGLOBAL):
    """Write a fixture node package and return its directory."""
    node = tmp_path / name
    node.mkdir()
    (node / '__init__.py').write_text('')
    (node / 'IGlobal.py').write_text(textwrap.dedent(global_source))
    (node / 'IInstance.py').write_text(textwrap.dedent(instance_source))
    return node


def _texts(outputs):
    """The text each call forwarded."""
    return [[args[0] for name, args in call if name == 'writeText'] for call in outputs]


def _count(owner):
    """One call that counts."""
    return Call(owner=owner, invoke=lambda instance: instance.writeText('tick'))


ALICE = Owner(orgId='org-a', userId='alice')
BOB = Owner(orgId='org-b', userId='bob')

# ==== The balancer test ==========================================================


def test_state_on_the_global_fails_the_two_replica_test(tmp_path):
    node = _node(tmp_path, 'counter_global', _ON_THE_GLOBAL)
    alternating, reference = run_alternating_and_alone(node, 'counter', 'counter_1', [_count(ALICE)] * 4)
    assert _texts(reference) == [['1'], ['2'], ['3'], ['4']]
    assert _texts(alternating) == [['1'], ['1'], ['2'], ['2']]
    assert alternating != reference


def test_state_in_self_state_passes_the_two_replica_test(tmp_path):
    node = _node(tmp_path, 'counter_state', _IN_STATE)
    alternating, reference = run_alternating_and_alone(node, 'counter', 'counter_1', [_count(ALICE)] * 4)
    assert _texts(reference) == [['1'], ['2'], ['3'], ['4']]
    assert alternating == reference


def test_the_idle_sweep_loses_nothing_in_self_state(tmp_path):
    node = _node(tmp_path, 'counter_swept', _IN_STATE)
    with ReplicaServer() as server:
        replica = Replica(server, node, 'counter', 'counter_1')
        first = run([_count(ALICE)] * 2, [replica])
        replica.end()
        second = run([_count(ALICE)] * 2, [replica])
    assert _texts(first + second) == [['1'], ['2'], ['3'], ['4']]


def test_each_server_has_its_own_file_root(tmp_path):
    # A count kept in a file starts from nothing on the reference server too
    node = _node(tmp_path, 'counter_file', _IN_A_FILE)
    alternating, reference = run_alternating_and_alone(node, 'counter', 'counter_1', [_count(ALICE)] * 3)
    assert _texts(reference) == [['1'], ['2'], ['3']]
    assert alternating == reference


def test_a_failed_setup_leaves_no_binding_behind(tmp_path):
    broken = 'from rocketlib import IGlobalBase\n\n\nclass IGlobal(IGlobalBase):\n    def beginGlobal(self):\n        raise RuntimeError("no global")\n'
    node = _node(tmp_path, 'counter_broken', _IN_STATE, broken)
    with ReplicaServer() as server:
        replica = Replica(server, node, 'counter', 'counter_1')
        with pytest.raises(RuntimeError, match='no global'):
            replica.call(_count(ALICE))
        assert server._owners == {}


def test_every_replica_ends_before_its_server_goes(tmp_path, monkeypatch):
    node = _node(tmp_path, 'counter_ends', _IN_STATE, _ENDS)
    ends = []
    real_end = Replica.end

    def end(self):
        # The server's channel is still installed when the replica ends
        ends.append(rocketlib.doors._channel is not None)
        real_end(self)

    monkeypatch.setattr(Replica, 'end', end)
    run_alternating_and_alone(node, 'counter', 'counter_1', [_count(ALICE)] * 2)
    assert ends == [True, True, True]

    def failing(instance):
        raise RuntimeError('the call failed')

    ends.clear()
    with pytest.raises(RuntimeError, match='the call failed'):
        run_alternating_and_alone(node, 'counter', 'counter_1', [Call(owner=ALICE, invoke=failing)])
    assert ends == [True, True]


# ==== The leak test ==============================================================


def test_one_owner_never_moves_another_owners_count(tmp_path):
    node = _node(tmp_path, 'counter_owners', _IN_STATE)
    interleaved = [_count(ALICE), _count(BOB), _count(ALICE), _count(BOB), _count(BOB)]
    alternating, reference = run_alternating_and_alone(node, 'counter', 'counter_1', interleaved)
    assert alternating == reference
    texts = _texts(alternating)
    assert [texts[0], texts[2]] == [['1'], ['2']]
    assert [texts[1], texts[3], texts[4]] == [['1'], ['2'], ['3']]


def test_two_nodes_of_one_pipeline_keep_their_own_count(tmp_path):
    # Both nodes name the key 'count' for one owner at one address: the node id
    # in the server's key keeps the two values apart
    node = _node(tmp_path, 'counter_nodes', _IN_STATE)
    with ReplicaServer() as server:
        first = Replica(server, node, 'counter', 'counter_1')
        second = Replica(server, node, 'counter', 'counter_2')
        outputs = run([_count(ALICE)] * 5, [first, second])
        scopes = sorted(server.state._scopes)
    texts = _texts(outputs)
    assert texts[0::2] == [['1'], ['2'], ['3']]
    assert texts[1::2] == [['1'], ['2']]
    assert [scope.rsplit('/', 1)[1] for scope in scopes] == ['counter_1', 'counter_2']


def test_a_binding_the_server_cannot_name_is_refused(tmp_path):
    node = _node(tmp_path, 'counter_unclaimed', _IN_STATE)
    with ReplicaServer() as server:
        replica = Replica(server, node, 'counter', 'counter_1')
        server.admit = lambda engine, correlation_id, owner: None
        with pytest.raises(Exception, match='belongs to no control'):
            replica.call(_count(ALICE))
