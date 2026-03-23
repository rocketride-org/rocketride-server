# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Smoke tests for pipeline nodes — fast, offline, no server required.

Tests node imports, instantiation, and basic contract compliance.
Catches broken imports, missing dependencies, and initialization crashes
that are common with vibe coding / fast iteration.

Usage:
    pytest nodes/test/test_smoke.py -v
    pytest nodes/test/test_smoke.py -v -x  # stop on first failure
"""

import importlib
import sys
from pathlib import Path

import pytest

# Reuse the JSONC parser from the test framework
sys.path.insert(0, str(Path(__file__).parent / 'framework'))
from discovery import _parse_service_json

NODES_DIR = Path(__file__).parent.parent / 'src' / 'nodes'


def discover_nodes():
    """Discover all node directories with services.json."""
    nodes = []
    for node_dir in sorted(NODES_DIR.iterdir()):
        if not node_dir.is_dir():
            continue
        if node_dir.name.startswith(('_', '.')):
            continue
        if node_dir.name == 'core':
            continue

        services_files = list(node_dir.glob('services*.json'))
        if services_files:
            nodes.append((node_dir.name, node_dir, services_files))
    return nodes


ALL_NODES = discover_nodes()
NODE_NAMES = [n[0] for n in ALL_NODES]


# ---------------------------------------------------------------------------
# Test: every node directory has required files
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(('name', 'node_dir', 'services_files'), ALL_NODES, ids=NODE_NAMES)
def test_node_has_init(name, node_dir, _services_files):
    """Every node must have an __init__.py."""
    init_file = node_dir / '__init__.py'
    assert init_file.exists(), f'{name}/ is missing __init__.py'


@pytest.mark.parametrize(('name', 'node_dir', 'services_files'), ALL_NODES, ids=NODE_NAMES)
def test_services_json_valid(name, node_dir, services_files):
    """Every services*.json must be valid JSON with required fields."""
    for sfile in services_files:
        data = _parse_service_json(str(sfile))
        if data is None:
            pytest.fail(f'{sfile.name} failed to parse')

        assert 'title' in data, f'{sfile.name} missing "title"'
        assert 'protocol' in data, f'{sfile.name} missing "protocol"'


# ---------------------------------------------------------------------------
# Test: every node's Python module can be imported without crashing
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(('name', 'node_dir', 'services_files'), ALL_NODES, ids=NODE_NAMES)
def test_node_importable(name, node_dir, services_files):
    """Node's __init__.py should import without errors."""
    # Add nodes/src to path
    src_dir = str(NODES_DIR)
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)

    try:
        mod = importlib.import_module(name)
        assert mod is not None
    except ImportError as e:
        # Missing optional dependencies are acceptable — skip
        pytest.skip(f'{name} has missing dependency: {e}')
    except Exception as e:
        pytest.fail(f'{name} crashes on import: {type(e).__name__}: {e}')


# ---------------------------------------------------------------------------
# Test: lane definitions are consistent
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(('name', 'node_dir', 'services_files'), ALL_NODES, ids=NODE_NAMES)
def test_lanes_valid(name, node_dir, services_files):
    """Lane definitions must reference valid lane names."""
    valid_lanes = {
        'text',
        'documents',
        'questions',
        'answers',
        'tags',
        'table',
        'audio',
        'video',
        'image',
    }

    for sfile in services_files:
        data = _parse_service_json(str(sfile))
        assert data is not None, f'{sfile.name} failed to parse'

        lanes = data.get('lanes', {})
        for input_lane, output_lanes in lanes.items():
            # Allow internal lanes prefixed with _
            if input_lane.startswith('_'):
                continue
            assert input_lane in valid_lanes, f'{sfile.name}: unknown input lane "{input_lane}". Valid: {valid_lanes}'
            for out_lane in output_lanes:
                if out_lane.startswith('_'):
                    continue
                assert out_lane in valid_lanes, f'{sfile.name}: unknown output lane "{out_lane}". Valid: {valid_lanes}'


# ---------------------------------------------------------------------------
# Test: no duplicate node protocols
# ---------------------------------------------------------------------------
def test_no_duplicate_protocols():
    """Each node must have a unique protocol identifier."""
    protocols = {}
    for name, _node_dir, services_files in ALL_NODES:
        for sfile in services_files:
            data = _parse_service_json(str(sfile))
            if data is None:
                continue

            protocol = data.get('protocol', '')
            if protocol:
                if protocol in protocols:
                    pytest.fail(f'Duplicate protocol "{protocol}": {name} and {protocols[protocol]}')
                protocols[protocol] = name
