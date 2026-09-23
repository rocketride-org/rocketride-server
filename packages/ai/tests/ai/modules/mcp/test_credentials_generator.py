# Copyright 2026 Aparavi Software AG. MIT License.
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[6]
SCRIPT = REPO / 'nodes' / 'scripts' / 'gen-credentials.mjs'


def run(root, catalog, *flags):
    return subprocess.run(
        ['node', str(SCRIPT), '--root', str(root), '--catalog', str(catalog), *flags],
        capture_output=True,
        text=True,
    )


def make_node(root, name, services):
    d = root / name
    d.mkdir(parents=True)
    (d / 'services.json').write_text(json.dumps(services), encoding='utf-8')


# dir name ('store_qdrant') deliberately differs from the protocol-derived
# service name ('qdrant') to exercise protocol-derived keying: the catalog
# must bucket under 'qdrant', never under the directory name.
QDRANT = {
    'title': 'Qdrant Store',
    'protocol': 'qdrant://',
    'prefix': 'qdrant',
    'preconfig': {'profiles': {'default': {'url': '', 'apikey': '', 'modelTotalTokens': 8192}}},
}


def test_stub_emitted_for_unmapped_credential_path(tmp_path):
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    make_node(root, 'store_qdrant', QDRANT)
    cat.write_text('{}', encoding='utf-8')
    assert run(root, cat).returncode == 0
    data = json.loads(cat.read_text())
    assert 'store_qdrant' not in data  # keyed by protocol-derived service name, not directory name
    fields = data['qdrant']['fields']
    paths = {f['path'] for f in fields}
    assert 'qdrant.apikey' in paths
    assert 'qdrant.modelTotalTokens' not in paths  # excluded token-count key
    stub = next(f for f in fields if f['path'] == 'qdrant.apikey')
    assert stub['suggests'] == 'ROCKETRIDE_QDRANT_APIKEY'
    assert stub['review'] is True


def test_curated_names_survive_regeneration(tmp_path):
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    make_node(root, 'store_qdrant', QDRANT)
    cat.write_text(
        json.dumps(
            {
                'qdrant': {
                    'title': 'Qdrant',
                    'fields': [
                        {
                            'path': 'qdrant.apikey',
                            'kind': 'secret',
                            'required': True,
                            'suggests': 'ROCKETRIDE_MY_CUSTOM_NAME',
                        },
                    ],
                },
            }
        ),
        encoding='utf-8',
    )
    assert run(root, cat).returncode == 0
    data = json.loads(cat.read_text())
    kept = next(f for f in data['qdrant']['fields'] if f['path'] == 'qdrant.apikey')
    assert kept['suggests'] == 'ROCKETRIDE_MY_CUSTOM_NAME'


def test_json5_comments_parse(tmp_path):
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    d = root / 'store_thing'
    d.mkdir(parents=True)
    (d / 'services.json').write_text(
        '{\n\t// comment\n\t"protocol": "thing://",\n\t"prefix": "thing",\n\t"preconfig": {"profiles": {"p": {"apikey": "",}}}\n}',
        encoding='utf-8',
    )
    cat.write_text('{}', encoding='utf-8')
    res = run(root, cat)
    assert res.returncode == 0, res.stderr
    assert 'thing.apikey' in cat.read_text()


def test_check_fails_on_unmapped_path(tmp_path):
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    make_node(root, 'store_qdrant', QDRANT)
    cat.write_text('{}', encoding='utf-8')
    res = run(root, cat, '--check')
    assert res.returncode == 1
    assert 'qdrant.apikey' in (res.stdout + res.stderr)
    assert cat.read_text() == '{}'  # --check never writes


def test_no_protocol_field_is_not_a_service(tmp_path):
    """A services*.json with no `protocol` field (e.g. a shared field
    fragment) declares no service and must not leak into the catalog under
    its directory name.
    """
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    d = root / 'core'
    d.mkdir(parents=True)
    (d / 'services.common.json').write_text(
        json.dumps({'fields': {'llm.cloud.apikey': {'type': 'string'}}}),
        encoding='utf-8',
    )
    cat.write_text('{}', encoding='utf-8')
    res = run(root, cat, '--check')
    assert res.returncode == 0, res.stdout + res.stderr
    assert run(root, cat).returncode == 0
    assert json.loads(cat.read_text()) == {}


def test_one_directory_multiple_services_bucketed_separately(tmp_path):
    """One node directory may declare several services (several
    services*.json files, each its own protocol) -- each must get its own
    catalog key.
    """
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    d = root / 'cloud_tts'
    d.mkdir(parents=True)
    (d / 'services.tts_elevenlabs.json').write_text(
        json.dumps(
            {
                'protocol': 'tts_elevenlabs://',
                'prefix': 'tts_elevenlabs',
                'preconfig': {'profiles': {'default': {'apikey': ''}}},
            }
        ),
        encoding='utf-8',
    )
    (d / 'services.tts_openai.json').write_text(
        json.dumps(
            {
                'protocol': 'tts_openai://',
                'prefix': 'tts_openai',
                'preconfig': {'profiles': {'default': {'apikey': ''}}},
            }
        ),
        encoding='utf-8',
    )
    cat.write_text('{}', encoding='utf-8')
    assert run(root, cat).returncode == 0
    data = json.loads(cat.read_text())
    assert 'cloud_tts' not in data
    assert {f['path'] for f in data['tts_elevenlabs']['fields']} == {'tts_elevenlabs.apikey'}
    assert {f['path'] for f in data['tts_openai']['fields']} == {'tts_openai.apikey'}


def test_check_fails_on_stale_entry(tmp_path):
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    root.mkdir()
    cat.write_text(
        json.dumps(
            {
                'gone_node': {
                    'fields': [
                        {'path': 'gone.apikey', 'suggests': 'ROCKETRIDE_GONE_APIKEY'},
                    ]
                }
            }
        ),
        encoding='utf-8',
    )
    assert run(root, cat, '--check').returncode == 1


def _catalog_with_extra_field(extra_field):
    return {
        'qdrant': {
            'title': 'Qdrant',
            'fields': [
                {
                    'path': 'qdrant.apikey',
                    'kind': 'secret',
                    'required': True,
                    'suggests': 'ROCKETRIDE_QDRANT_APIKEY',
                },
                extra_field,
            ],
        },
    }


def test_curated_field_on_existing_node_is_never_path_stale(tmp_path):
    """A human-curated field (no review flag) at a path the generator can't
    detect — e.g. a non-secret companion like an endpoint — must not be
    reported stale as long as its catalog key's service still exists.
    """
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    make_node(root, 'store_qdrant', QDRANT)
    cat.write_text(
        json.dumps(
            _catalog_with_extra_field(
                {
                    'path': 'qdrant.endpoint',
                    'title': 'Cluster endpoint',
                    'kind': 'endpoint',
                    'required': True,
                    'suggests': 'ROCKETRIDE_QDRANT_ENDPOINT',
                }
            )
        ),
        encoding='utf-8',
    )
    res = run(root, cat, '--check')
    assert res.returncode == 0, res.stdout + res.stderr
    assert 'qdrant.endpoint' not in (res.stdout + res.stderr)


def test_review_stub_on_existing_node_is_still_path_stale(tmp_path):
    """The same shape of field, but still carrying review:true, is a
    generator-owned stub — it must stay stale (and fail --check) when its
    path is no longer detected, same as before this change.
    """
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    make_node(root, 'store_qdrant', QDRANT)
    cat.write_text(
        json.dumps(
            _catalog_with_extra_field(
                {
                    'path': 'qdrant.stale_stub',
                    'kind': 'secret',
                    'required': True,
                    'suggests': 'ROCKETRIDE_QDRANT_STALE_STUB',
                    'review': True,
                }
            )
        ),
        encoding='utf-8',
    )
    res = run(root, cat, '--check')
    assert res.returncode == 1
    assert 'qdrant.stale_stub' in (res.stdout + res.stderr)


def test_fields_section_credential_detected_without_empty_default(tmp_path):
    """Defect B: a `fields`-section credential key with no empty-string
    default (or no default at all) must still be detected -- not just the
    `preconfig.profiles` empty-string case.
    """
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    d = root / 'graph_neo4j'
    d.mkdir(parents=True)
    (d / 'services.json').write_text(
        json.dumps(
            {
                'protocol': 'graph_neo4j://',
                'prefix': 'graph_neo4j',
                'fields': {
                    'graph_neo4j.password': {'type': 'string', 'title': 'Password', 'secure': True},
                    'graph_neo4j.uri': {
                        'type': 'string',
                        'title': 'Connection URI',
                        'default': 'neo4j://localhost:7687',
                    },
                },
            }
        ),
        encoding='utf-8',
    )
    cat.write_text('{}', encoding='utf-8')
    assert run(root, cat).returncode == 0
    data = json.loads(cat.read_text())
    paths = {f['path'] for f in data['graph_neo4j']['fields']}
    assert 'graph_neo4j.password' in paths  # no default at all -- still detected
    assert 'graph_neo4j.uri' not in paths  # non-credential key, correctly ignored


def test_fields_section_number_typed_credential_key_not_detected(tmp_path):
    """A `fields`-section entry whose key matches the credential regex but
    whose declared type is `number` (e.g. a token *count*, not a token
    *secret*) must never be stubbed as a secret -- the widened rule only
    fires for `string` (or untyped) fields.
    """
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    d = root / 'preprocessor_langchain'
    d.mkdir(parents=True)
    (d / 'services.json').write_text(
        json.dumps(
            {
                'protocol': 'preprocessor_langchain://',
                'prefix': 'langchain',
                'fields': {
                    'langchain.splitter.tokens': {'type': 'number', 'title': 'Number of tokens', 'default': 512},
                },
            }
        ),
        encoding='utf-8',
    )
    cat.write_text('{}', encoding='utf-8')
    assert run(root, cat).returncode == 0
    data = json.loads(cat.read_text())
    assert 'preprocessor_langchain' not in data  # no fields detected -- no stub, no empty entry


def test_invariant_flags_directory_keyed_catalog_entry(tmp_path):
    """A catalog key that matches a node DIRECTORY name but not any
    protocol-derived service name must fail --check with a distinct message
    naming the correct key(s) -- not just generic staleness.
    """
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    make_node(root, 'store_qdrant', QDRANT)  # dir 'store_qdrant', protocol 'qdrant://'
    cat.write_text(
        json.dumps(
            {
                'store_qdrant': {
                    'title': 'Qdrant',
                    'fields': [
                        {
                            'path': 'qdrant.apikey',
                            'kind': 'secret',
                            'required': True,
                            'suggests': 'ROCKETRIDE_QDRANT_APIKEY',
                        },
                    ],
                },
            }
        ),
        encoding='utf-8',
    )
    res = run(root, cat, '--check')
    assert res.returncode == 1
    out = res.stdout + res.stderr
    assert 'store_qdrant' in out
    assert 'qdrant' in out  # names the correct key to use instead
    assert cat.read_text() != ''  # --check never writes (unchanged from before)


def test_invariant_passes_once_keyed_by_service_name(tmp_path):
    """Once a catalog entry is renamed to the protocol-derived service name,
    the invariant no longer flags it.
    """
    root, cat = tmp_path / 'nodes', tmp_path / 'credentials.json'
    make_node(root, 'store_qdrant', QDRANT)
    cat.write_text(
        json.dumps(
            {
                'qdrant': {
                    'title': 'Qdrant',
                    'fields': [
                        {
                            'path': 'qdrant.apikey',
                            'kind': 'secret',
                            'required': True,
                            'suggests': 'ROCKETRIDE_QDRANT_APIKEY',
                        },
                    ],
                },
            }
        ),
        encoding='utf-8',
    )
    res = run(root, cat, '--check')
    assert res.returncode == 0, res.stdout + res.stderr
