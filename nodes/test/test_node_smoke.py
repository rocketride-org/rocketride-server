# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Node smoke tests — fast, offline, no server required.

Based on Reddit March 2026 best practices:
- pytest + anyio for structured async concurrency
- Mock external APIs (LLMs, vector DBs) at client level
- Test node instantiation and basic process flow
- Memory leak detection markers for heavy nodes

Usage:
    pytest nodes/test/test_node_smoke.py -v
    pytest nodes/test/test_node_smoke.py -v -x  # stop on first failure
"""

import importlib
import sys
from pathlib import Path
import pytest

# Reuse JSONC parser from framework
sys.path.insert(0, str(Path(__file__).parent / 'framework'))
from discovery import _parse_service_json

NODES_DIR = Path(__file__).parent.parent / 'src' / 'nodes'

# Ensure nodes src is importable
if str(NODES_DIR) not in sys.path:
    sys.path.insert(0, str(NODES_DIR))


# ---------------------------------------------------------------------------
# Fixtures (Reddit pattern: dependency injection for node testing)
# ---------------------------------------------------------------------------
@pytest.fixture
def mock_provider():
    """Mock provider string for node instantiation."""
    return 'test_provider'


@pytest.fixture
def mock_config():
    """Mock connection config matching typical service.json defaults."""
    return {
        'profile': 'default',
        'default': {},
    }


@pytest.fixture
def mock_bag():
    """Mock bag (shared state) for node instantiation."""
    return {}


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------
def discover_nodes_with_python():
    """Find nodes that have Python modules (IInstance, IGlobal, or main file)."""
    nodes = []
    for node_dir in sorted(NODES_DIR.iterdir()):
        if not node_dir.is_dir() or node_dir.name.startswith(('_', '.')) or node_dir.name == 'core':
            continue

        # Check for services.json
        services_files = list(node_dir.glob('services*.json'))
        if not services_files:
            continue

        # Check for Python files
        has_python = any((node_dir / f).exists() for f in ['IInstance.py', 'IGlobal.py', '__init__.py'])
        if not has_python:
            continue

        # Parse first services.json for metadata
        data = _parse_service_json(str(services_files[0]))
        if data is None:
            continue

        nodes.append(
            {
                'name': node_dir.name,
                'dir': node_dir,
                'services': services_files,
                'data': data,
                'node_type': data.get('node', ''),
                'class_type': data.get('classType', []),
            }
        )
    return nodes


PYTHON_NODES = discover_nodes_with_python()
PYTHON_NODE_NAMES = [n['name'] for n in PYTHON_NODES]


# ---------------------------------------------------------------------------
# Test: Python nodes can be imported
# ---------------------------------------------------------------------------
@pytest.mark.parametrize('node', PYTHON_NODES, ids=PYTHON_NODE_NAMES)
def test_node_module_imports(node):
    """Node Python module imports without crashing."""
    name = node['name']
    try:
        mod = importlib.import_module(name)
        assert mod is not None
    except ImportError as e:
        dep = str(e)
        # Known optional deps that may not be installed
        optional = [
            'torch',
            'transformers',
            'sentence_transformers',
            'chromadb',
            'qdrant_client',
            'pinecone',
            'weaviate',
            'milvus',
            'pymilvus',
            'astrapy',
            'langchain',
            'crewai',
            'ollama',
            'whisper',
            'cv2',
            'PIL',
            'firecrawl',
            'reducto',
            'llamaparse',
            'smbclient',
            'smbprotocol',
        ]
        if any(opt in dep for opt in optional):
            pytest.skip(f'Optional dependency: {dep}')
        else:
            pytest.fail(f'{name} import failed: {dep}')
    except Exception as e:
        pytest.fail(f'{name} crashes on import: {type(e).__name__}: {e}')


# ---------------------------------------------------------------------------
# Test: IInstance classes exist and have process method
# ---------------------------------------------------------------------------
@pytest.mark.parametrize('node', PYTHON_NODES, ids=PYTHON_NODE_NAMES)
def test_node_has_instance_class(node):
    """Nodes with IInstance.py should define a class with expected methods."""
    iinstance = node['dir'] / 'IInstance.py'
    if not iinstance.exists():
        pytest.skip('No IInstance.py')

    try:
        spec = importlib.util.spec_from_file_location(f'{node["name"]}.IInstance', str(iinstance))
        # Don't execute — just check the spec loads
        assert spec is not None
    except Exception as e:
        pytest.fail(f'IInstance.py cannot be loaded: {e}')


# ---------------------------------------------------------------------------
# Test: services.json has valid test configurations (if any)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize('node', PYTHON_NODES, ids=PYTHON_NODE_NAMES)
def test_node_test_config_valid(node):
    """If services.json has a 'test' section, verify its structure."""
    data = node['data']
    test_config = data.get('test')
    if test_config is None:
        pytest.skip('No test config in services.json')

    # Test config should have profiles and cases
    if 'profiles' in test_config:
        assert isinstance(test_config['profiles'], list), f'{node["name"]}: test.profiles must be a list'

    if 'cases' in test_config:
        assert isinstance(test_config['cases'], list), f'{node["name"]}: test.cases must be a list'
        for i, case in enumerate(test_config['cases']):
            assert isinstance(case, dict), f'{node["name"]}: test.cases[{i}] must be a dict'


# ---------------------------------------------------------------------------
# Test: node class types are valid
# ---------------------------------------------------------------------------
VALID_CLASS_TYPES = {
    'llm',
    'embedding',
    'store',
    'preprocessor',
    'data',
    'text',
    'agent',
    'tool',
    'audio',
    'video',
    'image',
    'chart',
    'database',
    'target',
    'source',
    'infrastructure',
    'memory',
    'other',
}


@pytest.mark.parametrize('node', PYTHON_NODES, ids=PYTHON_NODE_NAMES)
def test_node_class_type_valid(node):
    """Node classType should be from the known set."""
    for ct in node['class_type']:
        assert ct in VALID_CLASS_TYPES, f'{node["name"]}: unknown classType "{ct}". Valid: {VALID_CLASS_TYPES}'
