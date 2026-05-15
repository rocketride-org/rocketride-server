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

# =============================================================================
# Automatically discovers and runs tests for nodes with 'test' configurations
# in their service*.json files.
# =============================================================================

import pytest
from typing import Tuple, Optional

from .framework import NodeTestConfig, NodeTestRunner


class TestDynamicNodes:
    """
    Dynamic tests for nodes with test configurations.

    Tests are automatically generated based on 'test' keys found in
    service*.json files. Each node can define:

    - requires: Environment variables needed (test skipped if missing)
    - profiles: Profiles to test (separate test run per profile)
    - controls: Control nodes to attach
    - chain: Pipeline chain (* = node under test)
    - outputs: Output lanes to capture
    - cases: Test cases with input/expect definitions

    Example service.json test config:

        "test": {
            "requires": ["ROCKETRIDE_OPENAI_KEY"],
            "profiles": ["openai-3_5-4K"],
            "controls": ["llm_openai"],
            "chain": ["preprocessor_langchain", "*"],
            "cases": [
                {
                    "text": "What is 2+2?",
                    "expect": {
                        "answers": { "contains": "4" }
                    }
                },
                {
                    "image": "ocr/sample.png",
                    "expect": {
                        "text": { "contains": "Hello" }
                    }
                }
            ]
        }
    """

    @pytest.mark.asyncio
    async def test_node_cases(self, client, node_test_config: Tuple[NodeTestConfig, Optional[str]]):
        """
        Run all test cases for a node configuration.

        This test is parametrized by pytest_generate_tests in conftest.py
        to run once per (node, profile) combination that has required env vars.
        """
        config, profile = node_test_config

        # Create and set up the test runner
        runner = NodeTestRunner(client, config, profile)

        try:
            # Set up the pipeline
            await runner.setup()

            # Run each test case
            for i, case in enumerate(config.cases):
                case_id = f'{config.node_name}:{profile or "default"}:case_{i}'

                try:
                    results, errors = await runner.run_case(case)

                    # Report any validation errors
                    if errors:
                        error_msgs = [f'  - {e.path}: {e.args[0]}' for e in errors]
                        pytest.fail(
                            f'Test case {case_id} failed validation:\n'
                            + '\n'.join(error_msgs)
                            + f'\n\nResults: {results}'
                        )

                except Exception as e:
                    pytest.fail(f'Test case {case_id} raised exception: {e}')

        finally:
            await runner.teardown()


class TestNodeDiscovery:
    """Tests for the node discovery system itself."""

    def test_discover_testable_nodes(self, testable_nodes):
        """Verify that node discovery works."""
        # This doesn't assert a specific count since it depends on
        # which nodes have test configs
        assert isinstance(testable_nodes, list)

        for config in testable_nodes:
            assert isinstance(config, NodeTestConfig)
            assert config.node_name
            assert config.provider
            assert config.service_file

    def test_discovered_nodes_have_cases(self, testable_nodes):
        """Verify that discovered nodes have at least one test case."""
        for config in testable_nodes:
            assert len(config.cases) > 0, f'Node {config.node_name} has test config but no cases'

    def test_discovered_nodes_have_valid_chains(self, testable_nodes):
        """Verify that discovered nodes have valid chain configs."""
        for config in testable_nodes:
            # Chain should contain '*' for the node under test
            if config.chain:
                assert '*' in config.chain, f"Node {config.node_name} chain missing '*' placeholder"


class TestExpectationValidator:
    """Tests for the expectation validation system."""

    def test_equals_match(self):
        """Test equals matcher with lane-aware shortcut."""
        from .framework.expectations import ExpectationValidator

        # text lane output is List[str] (array of strings)
        validator = ExpectationValidator({'text': ['hello']})
        errors = validator.validate({'text': {'equals': 'hello'}})
        assert len(errors) == 0

        errors = validator.validate({'text': {'equals': 'world'}})
        assert len(errors) == 1

    def test_contains_match(self):
        """Test contains matcher with lane-aware shortcut."""
        from .framework.expectations import ExpectationValidator

        # text lane output is List[str] (array of strings)
        validator = ExpectationValidator({'text': ['hello world']})
        errors = validator.validate({'text': {'contains': 'world'}})
        assert len(errors) == 0

        errors = validator.validate({'text': {'contains': 'foo'}})
        assert len(errors) == 1

    def test_not_empty_match(self):
        """Test notEmpty matcher."""
        from .framework.expectations import ExpectationValidator

        validator = ExpectationValidator({'items': [1, 2, 3]})
        errors = validator.validate({'items': {'notEmpty': True}})
        assert len(errors) == 0

        validator = ExpectationValidator({'items': []})
        errors = validator.validate({'items': {'notEmpty': True}})
        assert len(errors) == 1

    def test_min_length_match(self):
        """Test minLength matcher."""
        from .framework.expectations import ExpectationValidator

        validator = ExpectationValidator({'items': [1, 2, 3]})
        errors = validator.validate({'items': {'minLength': 2}})
        assert len(errors) == 0

        errors = validator.validate({'items': {'minLength': 5}})
        assert len(errors) == 1

    def test_has_property_match(self):
        """Test hasProperty matcher."""
        from .framework.expectations import ExpectationValidator

        validator = ExpectationValidator({'data': {'nested': {'value': 123}}})
        errors = validator.validate({'data': {'hasProperty': 'nested'}})
        assert len(errors) == 0

        errors = validator.validate({'data': {'hasProperty': 'missing'}})
        assert len(errors) == 1

    def test_nested_property_match(self):
        """Test nested property matcher."""
        from .framework.expectations import ExpectationValidator

        validator = ExpectationValidator({'data': {'filter': {'objectIds': ['id1', 'id2']}}})

        errors = validator.validate({'data': {'property': {'path': 'filter.objectIds', 'minLength': 1}}})
        assert len(errors) == 0

    def test_any_matcher(self):
        """Test any matcher for arrays."""
        from .framework.expectations import ExpectationValidator

        validator = ExpectationValidator({'docs': [{'text': 'hello'}, {'text': 'world'}, {'text': 'foo'}]})

        errors = validator.validate({'docs': {'any': {'property': {'path': 'text', 'equals': 'world'}}}})
        assert len(errors) == 0

        errors = validator.validate({'docs': {'any': {'property': {'path': 'text', 'equals': 'missing'}}}})
        assert len(errors) == 1


class TestPipelineBuilder:
    """Tests for the pipeline builder."""

    def test_build_simple_pipeline(self):
        """Test building a simple pipeline."""
        from .framework import NodeTestConfig, PipelineBuilder

        config = NodeTestConfig(
            node_name='question', provider='question', service_file='test.json', chain=['*'], outputs=['questions']
        )

        builder = PipelineBuilder(config)
        pipeline = builder.build()

        assert 'components' in pipeline
        assert 'source' in pipeline

        # Should have webhook, node, response
        components = pipeline['components']
        providers = [c['provider'] for c in components]

        assert 'webhook' in providers
        assert 'question' in providers
        assert 'response' in providers

    def test_build_chain_pipeline(self):
        """Test building a pipeline with chain nodes."""
        from .framework import NodeTestConfig, PipelineBuilder

        config = NodeTestConfig(
            node_name='milvus',
            provider='milvus',
            service_file='test.json',
            chain=['preprocessor_langchain', 'embedding_transformer', '*'],
            outputs=['documents', 'answers'],
        )

        builder = PipelineBuilder(config)
        pipeline = builder.build()

        components = pipeline['components']
        providers = [c['provider'] for c in components]

        # Should have all chain nodes plus responses
        assert 'webhook' in providers
        assert 'preprocessor_langchain' in providers
        assert 'embedding_transformer' in providers
        assert 'milvus' in providers
        assert providers.count('response') == 2  # One per output lane
