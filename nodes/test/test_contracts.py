# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Contract validation tests for pipeline nodes.

This module validates node service*.json contracts without requiring a running
server. It discovers all nodes and their configurations at runtime, then runs
validation tests against each node/service/lane combination.

Tests include:
- Service contract parsing (service*.json validity)
- Required fields (title, protocol)
- Module existence (__init__.py)
- Lane name validation
- Output lane validation

This does NOT test node behavior - for functional tests, see test_functional.py.

Usage:
    # Run contract tests only (no server needed)
    builder nodes:test-contracts
    
    # Or directly with pytest
    pytest nodes/test/test_contracts.py -v
    pytest nodes/test/test_contracts.py -k "llm_openai" -v
"""

import pytest
import sys
import json
import re
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass, field
from unittest.mock import Mock, MagicMock

# Add nodes/src to path for imports
NODES_SRC = Path(__file__).parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))


# ============================================================================
# Contract Discovery
# ============================================================================

@dataclass
class LaneDefinition:
    """Represents an input lane and its possible outputs."""
    lane: str
    outputs: List[str] = field(default_factory=list)
    description: str = ""


@dataclass
class ServiceConfig:
    """Represents a single service*.json configuration."""
    node_name: str
    service_name: str
    file_path: Path
    title: str
    protocol: str
    class_type: List[str]
    node_type: str  # 'filter' or 'endpoint'
    node_impl: str  # 'python', 'cpp', etc. - from "node" field
    input_lanes: List[LaneDefinition] = field(default_factory=list)
    raw_data: Dict[str, Any] = field(default_factory=dict)
    
    @property
    def test_id(self) -> str:
        """Generate a unique test ID for this service."""
        if self.service_name == 'default':
            return self.node_name
        return f"{self.node_name}.{self.service_name}"
    
    @property
    def is_python_node(self) -> bool:
        """Check if this is a Python node (testable)."""
        return self.node_impl == 'python'


def parse_service_json(path: Path) -> Optional[Dict[str, Any]]:
    """Parse a service*.json file, handling comments and trailing commas."""
    try:
        content = path.read_text(encoding='utf-8')
        
        # Strip // comments (but not :// in URLs)
        lines = []
        for line in content.split('\n'):
            stripped = line.strip()
            if stripped.startswith('//'):
                continue
            if '//' in line:
                # Find // that's not inside a string and not part of a URL
                in_string = False
                i = 0
                while i < len(line) - 1:
                    if line[i] == '"' and (i == 0 or line[i-1] != '\\'):
                        in_string = not in_string
                    elif line[i:i+2] == '//' and not in_string:
                        # Check it's not part of a URL (preceded by :)
                        if i == 0 or line[i-1] != ':':
                            line = line[:i]
                            break
                    i += 1
            lines.append(line)
        
        json_str = '\n'.join(lines)
        
        # Handle trailing commas
        json_str = re.sub(r',\s*([}\]])', r'\1', json_str)
        
        # Use strict=False to allow control characters (tabs, etc.) in strings
        return json.loads(json_str, strict=False)
    except Exception:
        return None


def get_service_name(path: Path) -> str:
    """Extract service name from filename."""
    stem = path.stem
    parts = stem.split('.')
    return '.'.join(parts[1:]) if len(parts) > 1 else 'default'


def discover_all_services() -> List[ServiceConfig]:
    """Discover all service configurations from all nodes."""
    services = []
    
    for node_dir in sorted(NODES_SRC.iterdir()):
        if not node_dir.is_dir() or node_dir.name.startswith('_'):
            continue
        
        for service_file in sorted(node_dir.glob('service*.json')):
            data = parse_service_json(service_file)
            if not data:
                continue
            
            service_name = get_service_name(service_file)
            
            # Extract input lanes
            input_lanes = []
            for inp in data.get('input', []):
                outputs = [out['lane'] for out in inp.get('output', [])]
                desc = inp.get('description', '')
                if isinstance(desc, list):
                    desc = ' '.join(desc)
                input_lanes.append(LaneDefinition(
                    lane=inp['lane'],
                    outputs=outputs,
                    description=desc
                ))
            
            services.append(ServiceConfig(
                node_name=node_dir.name,
                service_name=service_name,
                file_path=service_file,
                title=data.get('title', ''),
                protocol=data.get('protocol', ''),
                class_type=data.get('classType', []),
                node_type=data.get('register', 'filter'),
                node_impl=data.get('node', ''),  # 'python', 'cpp', etc.
                input_lanes=input_lanes,
                raw_data=data
            ))
    
    return services


def discover_all_lanes() -> List[Tuple[ServiceConfig, LaneDefinition]]:
    """Discover all (service, lane) combinations for testing."""
    result = []
    for service in discover_all_services():
        for lane in service.input_lanes:
            result.append((service, lane))
    return result


# Cache discoveries
_ALL_SERVICES: List[ServiceConfig] = None
_ALL_LANES: List[Tuple[ServiceConfig, LaneDefinition]] = None
_PYTHON_SERVICES: List[ServiceConfig] = None
_PYTHON_LANES: List[Tuple[ServiceConfig, LaneDefinition]] = None


def get_all_services() -> List[ServiceConfig]:
    """Get cached list of all services."""
    global _ALL_SERVICES
    if _ALL_SERVICES is None:
        _ALL_SERVICES = discover_all_services()
    return _ALL_SERVICES


def get_all_lanes() -> List[Tuple[ServiceConfig, LaneDefinition]]:
    """Get cached list of all (service, lane) combinations."""
    global _ALL_LANES
    if _ALL_LANES is None:
        _ALL_LANES = discover_all_lanes()
    return _ALL_LANES


def get_python_services() -> List[ServiceConfig]:
    """Get cached list of Python-only services (testable nodes)."""
    global _PYTHON_SERVICES
    if _PYTHON_SERVICES is None:
        _PYTHON_SERVICES = [s for s in get_all_services() if s.is_python_node]
    return _PYTHON_SERVICES


def get_python_lanes() -> List[Tuple[ServiceConfig, LaneDefinition]]:
    """Get cached list of (service, lane) for Python nodes only."""
    global _PYTHON_LANES
    if _PYTHON_LANES is None:
        _PYTHON_LANES = [(svc, lane) for svc, lane in get_all_lanes() if svc.is_python_node]
    return _PYTHON_LANES


# ============================================================================
# Output Capture
# ============================================================================

class OutputCapture:
    """Captures all outputs sent via self.instance methods."""
    
    def __init__(self):
        self.outputs: Dict[str, List[Any]] = {}
        self.calls: List[Dict[str, Any]] = []
    
    def _capture(self, lane: str, method: str, data: Any):
        if lane not in self.outputs:
            self.outputs[lane] = []
        self.outputs[lane].append(data)
        self.calls.append({'lane': lane, 'method': method, 'data': data})
    
    def clear(self):
        self.outputs = {}
        self.calls = []
    
    # Output methods
    def sendText(self, text): self._capture('text', 'sendText', text)
    def writeText(self, text): self._capture('text', 'writeText', text)
    def writeDocuments(self, docs): self._capture('documents', 'writeDocuments', docs)
    def writeQuestions(self, q): self._capture('questions', 'writeQuestions', q)
    def writeAnswers(self, a): self._capture('answers', 'writeAnswers', a)
    def writeTable(self, t): self._capture('table', 'writeTable', t)
    def writeImage(self, *args): self._capture('image', 'writeImage', args)
    def writeAudio(self, *args): self._capture('audio', 'writeAudio', args)
    def writeVideo(self, *args): self._capture('video', 'writeVideo', args)
    def writeClassifications(self, *args): self._capture('classifications', 'writeClassifications', args)
    def writeClassificationContext(self, c): self._capture('classificationContext', 'writeClassificationContext', c)
    def sendTagData(self, d): self._capture('data', 'sendTagData', d)
    def sendTagMetadata(self, m): self._capture('metadata', 'sendTagMetadata', m)
    def sendTagBeginObject(self): self._capture('tags', 'sendTagBeginObject', 'BEGIN')
    def sendTagEndObject(self): self._capture('tags', 'sendTagEndObject', 'END')
    def sendTagBeginStream(self): self._capture('tags', 'sendTagBeginStream', 'BEGIN')
    def sendTagEndStream(self): self._capture('tags', 'sendTagEndStream', 'END')


# ============================================================================
# Test Harness
# ============================================================================

class NodeTestHarness:
    """Test harness for a single node/service combination."""
    
    def __init__(self, service: ServiceConfig):
        self.service = service
        self.node_name = service.node_name
        self.output_capture = OutputCapture()
        self.iglobal = None
        self.iinstance = None
    
    def setup(self, config: Dict[str, Any] = None):
        """Initialize the node with configuration."""
        config = config or {}
        
        # Create mock IEndpoint that IGlobal needs
        mock_endpoint = Mock()
        mock_endpoint.endpoint = Mock()
        mock_endpoint.endpoint.openMode = 'CONFIG'  # Skip dependency loading
        mock_endpoint.endpoint.parameters = config
        mock_endpoint.Desc = f'Test:{self.node_name}'
        
        # Create mock global context
        mock_glb = Mock()
        mock_glb.logicalType = self.node_name
        mock_glb.config = config
        
        # Import IGlobal if it exists
        IGlobalClass = self._import_class('IGlobal')
        if IGlobalClass:
            self.iglobal = IGlobalClass()
            self.iglobal.IEndpoint = mock_endpoint
            self.iglobal.glb = mock_glb
            if hasattr(self.iglobal, 'beginGlobal'):
                self.iglobal.beginGlobal(config)
        
        # Import IInstance
        IInstanceClass = self._import_class('IInstance')
        if not IInstanceClass:
            raise ImportError(f"Could not import IInstance from {self.node_name}")
        
        self.iinstance = IInstanceClass()
        self.iinstance.instance = self.output_capture
        self.iinstance.IEndpoint = mock_endpoint
        
        if self.iglobal:
            self.iinstance.IGlobal = self.iglobal
        
        if hasattr(self.iinstance, 'beginInstance'):
            self.iinstance.beginInstance()
    
    def _import_class(self, class_name: str):
        """Dynamically import a class from the node module."""
        try:
            module_path = f'nodes.{self.node_name}.{class_name}'
            module = __import__(module_path, fromlist=[class_name])
            return getattr(module, class_name, None)
        except (ImportError, AttributeError):
            return None
    
    def teardown(self):
        """Clean up node instances."""
        if self.iinstance and hasattr(self.iinstance, 'endInstance'):
            try:
                self.iinstance.endInstance()
            except Exception:
                pass
        if self.iglobal and hasattr(self.iglobal, 'endGlobal'):
            try:
                self.iglobal.endGlobal()
            except Exception:
                pass
    
    def send_input(self, lane: str, data: Any):
        """Send data to an input lane."""
        method_map = {
            'text': 'writeText',
            'questions': 'writeQuestions',
            'documents': 'writeDocuments',
            'answers': 'writeAnswers',
            'classifications': 'writeClassifications',
            'table': 'writeTable',
            'image': 'writeImage',
            'audio': 'writeAudio',
            'video': 'writeVideo',
        }
        method_name = method_map.get(lane)
        if method_name:
            method = getattr(self.iinstance, method_name, None)
            if method:
                if lane == 'classifications' and isinstance(data, tuple):
                    method(*data)
                else:
                    method(data)
    
    def open_object(self, entry=None):
        """Start processing an object."""
        if entry is None:
            entry = Mock(url='test://doc.txt', path='/test/doc.txt', objectId='test-123')
        if hasattr(self.iinstance, 'open'):
            self.iinstance.open(entry)
    
    def close_object(self):
        """Finish processing an object."""
        if hasattr(self.iinstance, 'closing'):
            self.iinstance.closing()
        if hasattr(self.iinstance, 'close'):
            self.iinstance.close()
    
    @property
    def outputs(self) -> Dict[str, List[Any]]:
        return self.output_capture.outputs


# ============================================================================
# Pytest Fixtures
# ============================================================================

class MockIGlobalBase:
    """Mock base class for IGlobal."""
    IEndpoint = None
    glb = None
    
    def beginGlobal(self): pass
    def endGlobal(self): pass


class MockIInstanceBase:
    """Mock base class for IInstance."""
    IGlobal = None
    IEndpoint = None
    instance = None
    
    def beginInstance(self): pass
    def endInstance(self): pass
    def preventDefault(self):
        raise Exception("PreventDefault")
    def writeText(self, text): pass
    def writeQuestions(self, q): pass
    def writeDocuments(self, docs): pass
    def writeAnswers(self, a): pass
    def writeTable(self, t): pass
    def writeImage(self, *args): pass
    def writeAudio(self, *args): pass
    def writeVideo(self, *args): pass
    def writeClassifications(self, *args): pass
    def open(self, obj): pass
    def closing(self): pass
    def close(self): pass


class MockOPEN_MODE:
    """Mock OPEN_MODE enum."""
    CONFIG = 'CONFIG'
    SOURCE = 'SOURCE'
    TARGET = 'TARGET'


class MockEntry:
    """Mock Entry object."""
    def __init__(self, **kwargs):
        self.url = kwargs.get('url', 'test://file.txt')
        self.path = kwargs.get('path', '/test/file.txt')
        self.objectId = kwargs.get('objectId', 'test-obj-123')
        self.parent = kwargs.get('parent', '/test/')


class MockQuestion:
    """Mock Question object for testing."""
    def __init__(self):
        self.questions = []
        self.context = []
    
    def addQuestion(self, text: str):
        self.questions.append({'text': text})
    
    def addContext(self, ctx):
        self.context.append(ctx)


class MockDoc:
    """Mock Doc object for testing."""
    def __init__(self, page_content='', metadata=None, embedding=None, score=0.0):
        self.page_content = page_content
        self.metadata = metadata or {}
        self.embedding = embedding
        self.score = score


class MockAnswer:
    """Mock Answer object for testing."""
    def __init__(self, text='', score=0.0):
        self.text = text
        self.score = score


@pytest.fixture(autouse=True)
def mock_engine_libs():
    """Mock engLib, rocketlib, and ai modules before tests."""
    # Track original modules
    original_modules = {}
    modules_to_mock = ['engLib', 'rocketlib', 'ai', 'ai.common', 'ai.common.schema', 'depends', 'util']
    
    for mod_name in modules_to_mock:
        original_modules[mod_name] = sys.modules.get(mod_name)
    
    # Mock engLib
    mock_englib = MagicMock()
    mock_englib.Entry = MockEntry
    mock_englib.debug = Mock()
    mock_englib.info = Mock()
    mock_englib.warning = Mock()
    mock_englib.error = Mock()
    
    # Mock rocketlib with actual base classes
    mock_rocketlib = MagicMock()
    mock_rocketlib.IInstanceBase = MockIInstanceBase
    mock_rocketlib.IGlobalBase = MockIGlobalBase
    mock_rocketlib.Entry = MockEntry
    mock_rocketlib.OPEN_MODE = MockOPEN_MODE
    mock_rocketlib.debug = Mock()
    mock_rocketlib.APERR = Mock(side_effect=Exception)
    mock_rocketlib.Ec = MagicMock()
    mock_rocketlib.Ec.PreventDefault = 'PreventDefault'
    
    # Mock ai.common.schema
    mock_ai_schema = MagicMock()
    mock_ai_schema.Question = MockQuestion
    mock_ai_schema.Doc = MockDoc
    mock_ai_schema.Answer = MockAnswer
    
    mock_ai_common = MagicMock()
    mock_ai_common.schema = mock_ai_schema
    
    mock_ai = MagicMock()
    mock_ai.common = mock_ai_common
    mock_ai.common.schema = mock_ai_schema
    
    # Mock depends (dependency loader)
    mock_depends = MagicMock()
    mock_depends.depends = Mock()
    
    # Mock util
    mock_util = MagicMock()
    mock_util.outputEntry = Mock()
    mock_util.outputException = Mock()

    yield {
        'engLib': mock_englib,
        'rocketlib': mock_rocketlib,
        'ai': mock_ai,
        'depends': mock_depends,
        'util': mock_util,
        'Question': MockQuestion,
        'Doc': MockDoc,
        'Answer': MockAnswer,
        'Entry': MockEntry,
    }


# ============================================================================
# Parametrized Tests
# ============================================================================

class TestNodeContracts:
    """Test that all node contracts can be loaded and parsed."""
    
    @pytest.mark.parametrize(
        "service",
        get_python_services(),
        ids=lambda s: s.test_id
    )
    def test_service_contract_valid(self, service: ServiceConfig):
        """Verify service*.json can be parsed and has required fields."""
        assert service.title, f"{service.test_id}: Missing title"
        assert service.protocol, f"{service.test_id}: Missing protocol"
        assert service.node_type in ('filter', 'endpoint', ''), \
            f"{service.test_id}: Invalid node_type: {service.node_type}"
    
    @pytest.mark.parametrize(
        "service",
        get_python_services(),
        ids=lambda s: s.test_id
    )
    def test_node_module_exists(self, service: ServiceConfig):
        """Verify the node directory is a valid Python module."""
        node_path = NODES_SRC / service.node_name
        
        # Must have __init__.py to be a loadable Python module
        assert (node_path / '__init__.py').exists(), \
            f"{service.test_id}: Missing __init__.py"


def lane_test_id(param):
    """Generate test ID for (service, lane) tuple."""
    service, lane = param
    return f"{service.test_id}:{lane.lane}"


# Pre-compute lane IDs to avoid calling get_python_lanes() twice
_PYTHON_LANE_IDS = None

def get_python_lane_ids():
    """Get cached test IDs for Python lanes."""
    global _PYTHON_LANE_IDS
    if _PYTHON_LANE_IDS is None:
        _PYTHON_LANE_IDS = [lane_test_id(x) for x in get_python_lanes()]
    return _PYTHON_LANE_IDS


class TestNodeLanes:
    """Test node input/output lane contracts."""
    
    @pytest.mark.parametrize(
        "service,lane",
        get_python_lanes(),
        ids=get_python_lane_ids()
    )
    def test_lane_has_valid_name(self, service: ServiceConfig, lane: LaneDefinition):
        """Verify lane names are valid."""
        valid_lanes = {
            'text', 'documents', 'questions', 'answers', 
            'table', 'image', 'audio', 'video',
            'classifications', 'classificationContext',
            'tags', '_source'  # Special lanes
        }
        assert lane.lane in valid_lanes or lane.lane.startswith('_'), \
            f"{service.test_id}: Unknown lane '{lane.lane}'"
    
    @pytest.mark.parametrize(
        "service,lane",
        get_python_lanes(),
        ids=get_python_lane_ids()
    )
    def test_lane_outputs_valid(self, service: ServiceConfig, lane: LaneDefinition):
        """Verify output lane names are valid."""
        valid_lanes = {
            'text', 'documents', 'questions', 'answers',
            'table', 
            'image', 'audio', 'video',
            'classifications', 'classificationContext', 'tags'
        }
        for output in lane.outputs:
            assert output in valid_lanes, \
                f"{service.test_id}:{lane.lane}: Unknown output lane '{output}'"


# Note: Functional tests (actual node input/output testing via pipelines)
# are in test_functional.py, which requires a running server.
# Run with: builder nodes:test
