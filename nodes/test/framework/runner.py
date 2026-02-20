# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .discovery import NodeTestConfig, TestCase
from .pipeline import PipelineBuilder
from .expectations import ExpectationValidator, ExpectationError


class NodeTestRunner:
    """
    Executes node tests using clients.python
    
    Handles:
        - Pipeline setup and teardown
        - Test data loading (inline or from files)
        - Running test cases through the pipeline
        - Result validation
    """
    
    def __init__(self, client, config: NodeTestConfig, profile: Optional[str] = None,
                 testdata_dir: Optional[str] = None):
        """
        Initialize the test runner.
        
        Args:
            client: RocketRideClient instance (connected)
            config: Node test configuration
            profile: Optional profile to use
            testdata_dir: Directory for test data files (default: ./testdata)
        """
        self.client = client
        self.config = config
        self.profile = profile
        self.testdata_dir = Path(testdata_dir) if testdata_dir else self._default_testdata_dir()
        self.pipeline = None
        self.token = None
        self._is_started = False
    
    def _default_testdata_dir(self) -> Path:
        """Get default testdata directory (project root/testdata)."""
        # Go up from framework -> test -> nodes -> project root
        return Path(__file__).parent.parent.parent.parent / 'testdata'
    
    async def setup(self) -> Dict[str, Any]:
        """
        Set up the test pipeline.
        
        Returns:
            The pipeline configuration that was used
        """
        import json
        
        builder = PipelineBuilder(self.config, self.profile)
        self.pipeline = builder.build()
        
        # Debug: Show pipeline structure
        print(f"\n{'='*60}")
        print(f"[SETUP] Building pipeline for node: {self.config.node_name}")
        print(f"[SETUP] Profile: {self.profile or 'default'}")
        print(f"[SETUP] Chain: {self.config.chain}")
        print(f"[SETUP] Controls: {self.config.controls}")
        print(f"[SETUP] Outputs: {self.config.outputs}")
        print(f"[SETUP] Pipeline:\n{json.dumps(self.pipeline, indent=2)}")
        print(f"{'='*60}\n")
        
        result = await self.client.use(pipeline=self.pipeline)
        self.token = result.get('token')
        self._is_started = True
        
        print(f"[SETUP] Pipeline started, token: {self.token}")
        
        return self.pipeline
    
    async def teardown(self):
        """Tear down the test pipeline."""
        if self._is_started and self.token:
            try:
                await self.client.terminate(self.token)
            except Exception:
                pass  # Ignore errors during teardown
            self._is_started = False
            self.token = None
    
    def _load_input_data(self, input_data: Any, input_lane: str) -> bytes:
        """
        Load test input data as bytes.
        
        Input type is inferred from the lane:
            - text, questions, answers, etc. → inline content (string)
            - image, audio, video, documents → file path
        
        Examples:
            "text": "What is the capital?"     → inline text as bytes
            "image": "ocr/sample.png"          → load file bytes
        
        Args:
            input_data: The input value (string for text, file path for media)
            input_lane: The target input lane (determines interpretation)
        
        Returns:
            Data as bytes
        """
        # Lanes that expect file paths
        FILE_LANES = {'image', 'audio', 'video', 'documents'}
        
        # For file-based lanes, treat string as file path
        if input_lane in FILE_LANES and isinstance(input_data, str):
            file_path = self.testdata_dir / input_data
            with open(file_path, 'rb') as f:
                return f.read()
        
        # Explicit file reference: {"file": "path"} (works for any lane)
        if isinstance(input_data, dict) and 'file' in input_data:
            file_path = self.testdata_dir / input_data['file']
            with open(file_path, 'rb') as f:
                return f.read()
        
        # String input for text-based lanes
        if isinstance(input_data, str):
            return input_data.encode('utf-8')
        
        # Dict without file key - treat as JSON object (like Question)
        if isinstance(input_data, dict):
            return json.dumps(input_data).encode('utf-8')
        
        # List (array of objects)
        if isinstance(input_data, list):
            return json.dumps(input_data).encode('utf-8')
        
        # Fallback
        return str(input_data).encode('utf-8')
    
    async def run_case(self, case: TestCase) -> Tuple[Dict[str, Any], List[ExpectationError]]:
        """
        Run a single test case.
        
        Args:
            case: The test case to run
        
        Returns:
            Tuple of (results_dict, validation_errors)
        """
        if not self._is_started:
            raise RuntimeError("Pipeline not started. Call setup() first.")
        
        # Load input data
        data_bytes = self._load_input_data(case.input_data, case.input_lane)
        
        # Use lane/* mime type to target the input lane directly
        mime_type = f"lane/{case.input_lane}"
        
        # Debug: Show what we're sending
        print(f"\n{'='*60}")
        print(f"[TEST] Node: {self.config.node_name}, Profile: {self.profile or 'default'}")
        print(f"[TEST] Input lane: {case.input_lane}, MIME type: {mime_type}")
        print(f"[TEST] Input data: {case.input_data}")
        print(f"[TEST] Expected outputs: {self.config.outputs}")
        
        # Get a pipe and send data
        pipe = await self.client.pipe(
            self.token,
            objinfo={'name': f'test_{case.input_lane}'},
            mime_type=mime_type
        )
        
        try:
            await pipe.open()
            await pipe.write(data_bytes)
            result = await pipe.close()
        finally:
            # Ensure pipe is released
            pass
        
        # Debug: Show raw result (safely encode for Windows console)
        print(f"[TEST] Raw result keys: {result.keys() if isinstance(result, dict) else type(result)}")
        try:
            print(f"[TEST] Raw result: {result}")
        except UnicodeEncodeError:
            # Windows console can't display some Unicode chars (like █)
            print(f"[TEST] Raw result: {str(result).encode('ascii', 'replace').decode('ascii')}")
        
        # Extract results per output lane
        results = self._extract_results(result)
        
        # Debug: Show extracted results (safely encode for Windows console)
        try:
            print(f"[TEST] Extracted results: {results}")
            print(f"[TEST] Expected: {case.expect}")
        except UnicodeEncodeError:
            print(f"[TEST] Extracted results: {str(results).encode('ascii', 'replace').decode('ascii')}")
            print(f"[TEST] Expected: {str(case.expect).encode('ascii', 'replace').decode('ascii')}")
        print(f"{'='*60}\n")
        
        # Validate expectations
        validator = ExpectationValidator(results)
        errors = validator.validate(case.expect)
        
        return results, errors
    
    def _extract_results(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract results organized by output lane.
        
        The response node captures results, and we need to organize
        them by which output lane they came from.
        """
        # Result structure depends on how response nodes capture data
        # For now, return the raw result and let tests parse it
        
        results = {}
        
        # Check for lane-specific results in the response
        if isinstance(result, dict):
            # Look for known lane result keys
            for lane in self.config.outputs:
                if lane in result:
                    results[lane] = result[lane]
                elif f'{lane}_output' in result:
                    results[lane] = result[f'{lane}_output']
            
            # If no specific lanes found, use the whole result
            if not results:
                # Try to detect the result structure
                if 'response' in result:
                    results['default'] = result['response']
                else:
                    results['default'] = result
        else:
            results['default'] = result
        
        return results
    
    async def run_all_cases(self) -> List[Tuple[TestCase, Dict[str, Any], List[ExpectationError]]]:
        """
        Run all test cases.
        
        Returns:
            List of (case, results, errors) tuples
        """
        results = []
        
        for case in self.config.cases:
            case_results, errors = await self.run_case(case)
            results.append((case, case_results, errors))
        
        return results


async def run_node_tests(client, config: NodeTestConfig, 
                         profile: Optional[str] = None) -> List[Tuple[TestCase, Dict[str, Any], List[ExpectationError]]]:
    """
    Convenience function to run all tests for a node configuration.
    
    Args:
        client: Connected RocketRideClient
        config: Node test configuration
        profile: Optional profile to use
    
    Returns:
        List of (case, results, errors) tuples
    """
    runner = NodeTestRunner(client, config, profile)
    
    try:
        await runner.setup()
        return await runner.run_all_cases()
    finally:
        await runner.teardown()

