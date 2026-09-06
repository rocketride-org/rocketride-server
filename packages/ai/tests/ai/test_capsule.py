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
    MAX_CAPSULE_BYTES,
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


def _zip(members, compress=False):
    """Build a raw capsule zip from {arcname: bytes}."""
    import io
    import zipfile

    mode = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', mode) as zf:
        for arc, body in members.items():
            zf.writestr(arc, body)
    return buf.getvalue()


class TestPayloadKeyEscapes:
    """
    The archive name is checked, but the key handed back is what gets joined onto
    a node directory. A member traversing inside an accepted prefix normalises to
    something with no leading '..', passes the prefix check, and still escapes.
    """

    def _capsule(self, arc):
        import json

        return _zip({'capsule.json': json.dumps({'name': 'demo'}), arc: b'payload'})

    def test_traversal_inside_the_node_prefix_is_rejected(self):
        # local_nodes/demo/sub/../../evil.py -> normalises to local_nodes/evil.py
        with pytest.raises(CapsuleError):
            read_capsule(self._capsule('local_nodes/demo/sub/../../evil.py'))

    def test_traversal_out_of_local_nodes_is_rejected(self):
        with pytest.raises(CapsuleError):
            read_capsule(self._capsule('local_nodes/demo/sub/../../../evil.py'))

    def test_a_backslash_traversal_is_rejected(self):
        with pytest.raises(CapsuleError):
            read_capsule(self._capsule('local_nodes/demo/sub\\..\\..\\evil.py'))

    def test_a_nested_path_still_works(self):
        manifest, payload = read_capsule(self._capsule('local_nodes/demo/sub/helper.py'))
        assert list(payload) == ['sub/helper.py']


class TestExpansionBounds:
    """
    The byte cap bounds the compressed archive only. Every member is then read
    whole into memory, so a few hundred KiB of zeros becomes hundreds of MiB
    resident unless the expanded size is bounded too.

    Exercised against lowered limits rather than a real bomb: building one costs
    the test run the same memory the guard exists to prevent.
    """

    def _capsule(self, payload_size):
        import json

        return _zip(
            {
                'capsule.json': json.dumps({'name': 'demo'}),
                'local_nodes/demo/big.bin': b'\0' * payload_size,
            },
            compress=True,
        )

    def test_expansion_beyond_the_bound_is_refused(self, monkeypatch):
        monkeypatch.setattr('ai.account.capsule.MAX_UNCOMPRESSED_BYTES', 1024)
        bomb = self._capsule(64 * 1024)
        # The point of the guard: it sails past the compressed cap.
        assert len(bomb) < MAX_CAPSULE_BYTES
        with pytest.raises(CapsuleError):
            read_capsule(bomb)

    def test_a_payload_within_the_bound_still_reads(self, monkeypatch):
        monkeypatch.setattr('ai.account.capsule.MAX_UNCOMPRESSED_BYTES', 1024 * 1024)
        _, payload = read_capsule(self._capsule(4096))
        assert len(payload['big.bin']) == 4096

    def test_too_many_members_is_refused(self, monkeypatch):
        import json

        monkeypatch.setattr('ai.account.capsule.MAX_CAPSULE_MEMBERS', 5)
        members = {'capsule.json': json.dumps({'name': 'demo'})}
        for i in range(10):
            members[f'local_nodes/demo/f{i}.py'] = b'x'
        with pytest.raises(CapsuleError):
            read_capsule(_zip(members))


class TestManifestChecks:
    def test_a_traversing_name_is_refused_where_it_is_read(self):
        import json

        with pytest.raises(CapsuleError):
            read_capsule(_zip({'capsule.json': json.dumps({'name': '../evil'})}))

    def test_a_non_object_manifest_is_refused(self):
        with pytest.raises(CapsuleError):
            read_capsule(_zip({'capsule.json': '["not", "an", "object"]'}))

    def test_the_recorded_digest_is_checked(self):
        packed = pack_capsule('demo', {'IGlobal.py': 'x = 1\n'})
        manifest, _ = read_capsule(packed)
        assert manifest['sha256']

        # Same capsule with one byte of the payload changed.
        import io
        import json
        import zipfile

        src = zipfile.ZipFile(io.BytesIO(packed))
        members = {}
        for arc in src.namelist():
            body = src.read(arc)
            if arc.endswith('IGlobal.py'):
                body = b'x = 2\n'
            members[arc] = body
        with pytest.raises(CapsuleError):
            read_capsule(_zip(members))
        assert json.loads(members['capsule.json'])['sha256'] == manifest['sha256']
