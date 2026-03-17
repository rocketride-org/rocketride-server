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

import os
import re
import json
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional


# Known input lane names for detecting which key is the input
KNOWN_INPUT_LANES = {
    'text', 'image', 'documents', 'audio', 'video', 
    'questions', 'answers', 'table', 'classifications', 'tags', '_source'
}

# Lanes where the value is a file path (not inline content)
FILE_INPUT_LANES = {'image', 'audio', 'video', 'documents'}


@dataclass
class TestCase:
    """A single test case from a node's test configuration."""
    input_lane: str
    input_data: Any  # {"text": "..."} or {"file": "path"}
    expect: Optional[Dict[str, Any]] = None  # lane -> expectations
    name: Optional[str] = None  # optional test name


@dataclass
class NodeTestConfig:
    """Test configuration for a node, parsed from service*.json."""
    node_name: str
    provider: str
    service_file: str
    
    # Test configuration
    requires: List[str] = field(default_factory=list)
    profiles: List[str] = field(default_factory=list)
    controls: List[str] = field(default_factory=list)
    chain: List[str] = field(default_factory=list)
    outputs: List[str] = field(default_factory=list)
    timeout: int = 60
    cases: List[TestCase] = field(default_factory=list)
    
    # Node metadata
    preconfig: Dict[str, Any] = field(default_factory=dict)
    lanes: Dict[str, Any] = field(default_factory=dict)

    def get_test_id(self) -> str:
        """Generate a unique test ID for this node config."""
        return f"{self.node_name}:{Path(self.service_file).stem}"

    def has_required_env_vars(self) -> bool:
        """Check if all required environment variables are set."""
        for var in self.requires:
            if not os.environ.get(var):
                return False
        return True

    def get_missing_env_vars(self) -> List[str]:
        """Return list of missing required environment variables."""
        return [var for var in self.requires if not os.environ.get(var)]


def _remove_json_comments(content: str) -> str:
    """Remove JavaScript-style comments from JSON content."""
    # Process line by line to avoid matching // inside strings
    lines = content.split('\n')
    result_lines = []
    
    in_multiline_comment = False
    
    for line in lines:
        # Handle multi-line comments
        if in_multiline_comment:
            if '*/' in line:
                line = line[line.index('*/') + 2:]
                in_multiline_comment = False
            else:
                result_lines.append('')
                continue
        
        if '/*' in line:
            # Check if it's not inside a string (simple heuristic: before any quote)
            comment_pos = line.find('/*')
            quote_pos = line.find('"')
            if quote_pos == -1 or comment_pos < quote_pos:
                if '*/' in line[comment_pos:]:
                    # Single line /* */ comment
                    end_pos = line.index('*/', comment_pos) + 2
                    line = line[:comment_pos] + line[end_pos:]
                else:
                    line = line[:comment_pos]
                    in_multiline_comment = True
        
        # Remove single-line comments, but only if // is not inside a string
        # Simple heuristic: only match // at start of line or after whitespace
        # and not preceded by : (which would be in a URL like "http://")
        if '//' in line:
            # Find // that's not inside a string
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
        
        result_lines.append(line)
    
    return '\n'.join(result_lines)


def _remove_trailing_commas(content: str) -> str:
    """Remove trailing commas before } or ]."""
    content = re.sub(r',(\s*[}\]])', r'\1', content)
    return content


def _parse_service_json(file_path: str) -> Optional[Dict[str, Any]]:
    """Parse a service*.json file, handling comments and trailing commas."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        content = _remove_json_comments(content)
        content = _remove_trailing_commas(content)
        
        # Use strict=False to allow control characters (tabs, etc.) in strings
        return json.loads(content, strict=False)
    except Exception as e:
        print(f"Warning: Failed to parse {file_path}: {e}")
        return None


def _parse_test_case(case_data: Dict[str, Any]) -> TestCase:
    """
    Parse a single test case from the new format.
    
    New format uses lane name as key:
        { "text": "What is the capital?", "expect": {...} }
        { "image": "testdata/ocr/sample.png", "expect": {...} }
        { "text": { "text": "content" }, "expect": {...} }  # explicit object
    
    Also supports legacy format for backwards compatibility:
        { "inputLane": "text", "inputData": "...", "expect": {...} }
    """
    # Check for legacy format first
    if 'inputLane' in case_data:
        return TestCase(
            input_lane=case_data.get('inputLane', 'text'),
            input_data=case_data.get('inputData', ''),
            expect=case_data.get('expect'),
            name=case_data.get('name')
        )
    
    # New format: find the input lane key
    input_lane = None
    input_data = None
    
    for key, value in case_data.items():
        if key in KNOWN_INPUT_LANES:
            input_lane = key
            input_data = value
            break
    
    if input_lane is None:
        # Default to text if no lane key found
        input_lane = 'text'
        input_data = ''
    
    return TestCase(
        input_lane=input_lane,
        input_data=input_data,
        expect=case_data.get('expect'),
        name=case_data.get('name')
    )


def _infer_outputs_from_cases(cases: List[TestCase]) -> List[str]:
    """Infer output lanes from expect keys across all test cases."""
    outputs = set()
    for case in cases:
        if case.expect:
            outputs.update(case.expect.keys())
    return sorted(outputs)


def _parse_test_config(node_name: str, service_file: str, data: Dict[str, Any], test_key: str = 'test') -> List[NodeTestConfig]:
    """Parse a test key (e.g. 'test' or 'fulltest') from a service.json into a list of NodeTestConfig.

    The value may be a single object or an array of objects (array format allows
    different profiles/cases per group within the same service file).
    """
    test_data = data.get(test_key)
    if not test_data:
        return []

    # Only test Python nodes
    if data.get('node') != 'python':
        return []

    # Get provider from protocol (strip the :// suffix)
    protocol = data.get('protocol', '')
    if not protocol:
        raise ValueError(f"Node {node_name} missing required 'protocol' field in {service_file}")
    provider = protocol.replace('://', '')

    # Support both a single object and an array of objects
    groups = test_data if isinstance(test_data, list) else [test_data]

    configs = []
    for group in groups:
        # Parse test cases using new format
        cases = []
        for case_data in group.get('cases', []):
            case = _parse_test_case(case_data)
            cases.append(case)

        # Infer outputs from expect keys only when outputs key is not present
        outputs = group.get('outputs')
        if outputs is None:
            outputs = _infer_outputs_from_cases(cases)

        configs.append(NodeTestConfig(
            node_name=node_name,
            provider=provider,
            service_file=service_file,
            requires=group.get('requires', []),
            profiles=group.get('profiles', []),
            controls=group.get('controls', []),
            chain=group.get('chain', ['*']),
            outputs=outputs,
            timeout=group.get('timeout', 60),
            cases=cases,
            preconfig=data.get('preconfig', {}),
            lanes=data.get('lanes', {})
        ))

    return configs


def discover_testable_nodes(nodes_src_dir: str = None, test_key: str = 'test') -> List[NodeTestConfig]:
    """
    Discover all nodes with test configurations.

    Scans nodes/src/*/service*.json for files containing the given test key.
    Use test_key='fulltest' to discover nodes with full-profile test configs.
    Returns a list of NodeTestConfig objects for nodes that can be tested.
    """
    if nodes_src_dir is None:
        # Default to nodes/src/nodes relative to this file
        framework_dir = Path(__file__).parent
        nodes_src_dir = framework_dir.parent.parent / 'src' / 'nodes'

    nodes_src_dir = Path(nodes_src_dir)
    testable_nodes = []

    # Scan all node directories
    for node_dir in nodes_src_dir.iterdir():
        if not node_dir.is_dir():
            continue

        node_name = node_dir.name

        # Find all service*.json files
        for service_file in node_dir.glob('service*.json'):
            data = _parse_service_json(str(service_file))
            if data is None:
                continue

            configs = _parse_test_config(node_name, str(service_file), data, test_key=test_key)
            testable_nodes.extend(configs)

    return testable_nodes


def get_node_test_config(node_name: str, nodes_src_dir: str = None) -> Optional[NodeTestConfig]:
    """Get the test configuration for a specific node."""
    configs = discover_testable_nodes(nodes_src_dir)
    for config in configs:
        if config.node_name == node_name:
            return config
    return None

