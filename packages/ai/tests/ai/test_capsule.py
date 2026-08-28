# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The .rrc capsule packs and reads back a node, and refuses a malformed archive."""

import io
import json
import zipfile

import pytest

from ai.account.capsule import (
    MANIFEST_NAME,
    NODES_ROOT,
    CapsuleError,
    pack_capsule,
    read_capsule,
)
from ai.account.node_scaffold import scaffold_node


def test_pack_then_read_round_trips_a_scaffolded_node():
    files = scaffold_node('packme', kind='source')
    blob = pack_capsule('packme', files, version='1.2.3', declares=['network'])
    manifest, payload = read_capsule(blob)
    assert manifest['name'] == 'packme'
    assert manifest['protocol'] == 'packme://'
    assert manifest['version'] == '1.2.3'
    assert manifest['declares'] == ['network']
    # Payload comes back keyed relative to the node folder, byte-identical.
    assert payload['services.json'].decode('utf-8') == files['services.json']
    assert 'IEndpoint.py' in payload


def test_payload_lands_under_local_nodes():
    blob = pack_capsule('layout', scaffold_node('layout'))
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        names = zf.namelist()
    assert MANIFEST_NAME in names
    assert any(n.startswith(f'{NODES_ROOT}/layout/') for n in names)


def test_pack_skips_cruft():
    files = scaffold_node('clean')
    files['__pycache__/IGlobal.cpython-312.pyc'] = 'x'
    files['stale.pyc'] = 'x'
    _, payload = read_capsule(pack_capsule('clean', files))
    assert not any('__pycache__' in p or p.endswith('.pyc') for p in payload)


def test_read_rejects_a_non_zip():
    with pytest.raises(CapsuleError):
        read_capsule(b'not a zip at all')


def test_read_rejects_missing_manifest():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr(f'{NODES_ROOT}/x/services.json', '{}')
    with pytest.raises(CapsuleError):
        read_capsule(buf.getvalue())


def test_read_rejects_zip_slip():
    # A member escaping the archive root must never be accepted for extraction.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr(MANIFEST_NAME, json.dumps({'name': 'x'}))
        zf.writestr('../evil.py', 'boom')
    with pytest.raises(CapsuleError):
        read_capsule(buf.getvalue())


def test_read_rejects_payload_outside_node_folder():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr(MANIFEST_NAME, json.dumps({'name': 'x'}))
        zf.writestr(f'{NODES_ROOT}/other/thing.py', 'pass')  # name mismatch
    with pytest.raises(CapsuleError):
        read_capsule(buf.getvalue())
