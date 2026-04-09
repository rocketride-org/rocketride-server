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
# Full test suite: runs all profiles defined under the 'fulltest' key in
# service*.json files. Invoked via: builder model_server:fulltest
#
# Unlike test_dynamic.py (which uses the 'test' key and skips heavy nodes),
# this suite is opt-in and exercises every profile listed in 'fulltest'.
# =============================================================================

import pytest
from typing import Tuple, Optional

from .framework import NodeTestConfig, NodeTestRunner


class TestDynamicNodesFull:
    """
    Full profile tests for nodes with 'fulltest' configurations.

    Tests are automatically generated based on 'fulltest' keys found in
    service*.json files. Each entry in 'profiles' produces a separate test run,
    so every supported model variant is exercised independently.

    Run via:
        builder model_server:fulltest
    """

    @pytest.mark.asyncio
    async def test_node_cases(self, client, node_fulltest_config: Tuple[NodeTestConfig, Optional[str]]):
        """
        Run all test cases for a node fulltest configuration.

        Parametrized by pytest_generate_tests in conftest.py to run once per
        (node, profile) combination found in the 'fulltest' section of
        service*.json files.
        """
        config, profile = node_fulltest_config

        runner = NodeTestRunner(client, config, profile)

        try:
            await runner.setup()

            for i, case in enumerate(config.cases):
                case_id = f"{config.node_name}:{profile or 'default'}:case_{i}"

                try:
                    results, errors = await runner.run_case(case)

                    if errors:
                        error_msgs = [
                            f"  - {e.path}: {e.args[0]}"
                            for e in errors
                        ]
                        pytest.fail(
                            f"Test case {case_id} failed validation:\n" +
                            "\n".join(error_msgs) +
                            f"\n\nResults: {results}"
                        )

                except Exception as e:
                    pytest.fail(f"Test case {case_id} raised exception: {e}")

        finally:
            await runner.teardown()
