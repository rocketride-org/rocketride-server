"""
Unit tests for ai.modules.task.services_catalog.

The catalog is a build-once cache over the engine's bulk service
definitions: the master view keeps full entries, the summary view keeps
display fields plus a deduplicated icon table (service ``icon`` fields are
opaque ids into ``summary['icons']``), and the absolute icon path the
engine resolves at load time never appears in either view.
"""

from __future__ import annotations

import pytest

from ai.modules.task import services_catalog


@pytest.fixture(autouse=True)
def cold_cache():
    """Every test starts and ends with an empty catalog cache."""
    services_catalog.invalidate()
    yield
    services_catalog.invalidate()


def _fake_definitions(tmp_path):
    """
    Build a raw engine response exercising the icon corner cases:

    - ``ocr`` / ``ocr_twin``   — two services, same icon FILE (shared path)
    - ``copycat``              — different file, byte-identical CONTENT
    - ``clash``                — same FILENAME as ocr's, different content
    - ``noicon``               — icon path that does not exist on disk
    """
    (tmp_path / 'a').mkdir()
    (tmp_path / 'b').mkdir()
    shared = tmp_path / 'a' / 'shared.svg'
    shared.write_text('<svg>shared</svg>', encoding='utf-8')
    copy = tmp_path / 'b' / 'copy.svg'
    copy.write_text('<svg>shared</svg>', encoding='utf-8')
    clash = tmp_path / 'b' / 'shared.svg'
    clash.write_text('<svg>different</svg>', encoding='utf-8')

    def entry(icon_path, **extra):
        return {'title': 'T', 'protocol': 'p', 'icon': str(icon_path), **extra}

    return {
        'services': {
            'ocr': entry(shared, General={'fields': [{'name': 'language'}]}),
            'ocr_twin': entry(shared),
            'copycat': entry(copy),
            'clash': entry(clash),
            'noicon': entry(tmp_path / 'missing.svg'),
        },
        'version': 42,
    }


@pytest.mark.asyncio
async def test_summary_dedups_icons_by_content(monkeypatch, tmp_path):
    raw = _fake_definitions(tmp_path)
    monkeypatch.setattr(services_catalog, 'getServiceDefinitions', lambda: raw)

    summary = await services_catalog.get_summary()
    svcs, icons = summary['services'], summary['icons']

    assert summary['version'] == 42
    # Same file and byte-identical copy share ONE table entry
    assert svcs['ocr']['icon'] == svcs['ocr_twin']['icon'] == svcs['copycat']['icon']
    # Same filename, different content -> different id
    assert svcs['clash']['icon'] != svcs['ocr']['icon']
    # Exactly two distinct SVGs in the table
    assert len(icons) == 2
    assert icons[svcs['ocr']['icon']] == '<svg>shared</svg>'
    assert icons[svcs['clash']['icon']] == '<svg>different</svg>'


@pytest.mark.asyncio
async def test_summary_drops_schema_and_paths(monkeypatch, tmp_path):
    raw = _fake_definitions(tmp_path)
    monkeypatch.setattr(services_catalog, 'getServiceDefinitions', lambda: raw)

    summary = await services_catalog.get_summary()
    ocr = summary['services']['ocr']

    assert ocr['title'] == 'T'
    # No config schema sections in the summary
    assert 'General' not in ocr
    # icon is an id into the table, never a filesystem path
    assert ocr['icon'] in summary['icons']


@pytest.mark.asyncio
async def test_get_service_returns_full_entry_without_icon(monkeypatch, tmp_path):
    raw = _fake_definitions(tmp_path)
    monkeypatch.setattr(services_catalog, 'getServiceDefinitions', lambda: raw)

    entry = await services_catalog.get_service('ocr')

    assert entry is not None
    # Full entry keeps the config schema...
    assert entry['General'] == {'fields': [{'name': 'language'}]}
    # ...and carries no icon at all (path or otherwise)
    assert 'icon' not in entry
    assert 'iconSvg' not in entry


@pytest.mark.asyncio
async def test_missing_icon_file_is_tolerated(monkeypatch, tmp_path):
    raw = _fake_definitions(tmp_path)
    monkeypatch.setattr(services_catalog, 'getServiceDefinitions', lambda: raw)

    summary = await services_catalog.get_summary()

    assert 'icon' not in summary['services']['noicon']


@pytest.mark.asyncio
async def test_unknown_service_returns_none(monkeypatch, tmp_path):
    raw = _fake_definitions(tmp_path)
    monkeypatch.setattr(services_catalog, 'getServiceDefinitions', lambda: raw)

    assert await services_catalog.get_service('nope') is None


@pytest.mark.asyncio
async def test_build_runs_once_until_invalidated(monkeypatch, tmp_path):
    raw = _fake_definitions(tmp_path)
    calls = {'n': 0}

    def counting():
        calls['n'] += 1
        return raw

    monkeypatch.setattr(services_catalog, 'getServiceDefinitions', counting)

    await services_catalog.get_summary()
    await services_catalog.get_service('ocr')
    await services_catalog.get_summary()
    assert calls['n'] == 1

    services_catalog.invalidate()
    await services_catalog.get_summary()
    assert calls['n'] == 2
