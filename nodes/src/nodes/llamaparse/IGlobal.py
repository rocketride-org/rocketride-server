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

import json
import os
import threading
from typing import TYPE_CHECKING

from rocketlib import IGlobalBase, debug, warning

if TYPE_CHECKING:
    from llama_parse import LlamaParse

    from .parser import Parser


class IGlobal(IGlobalBase):
    """Global state: the shared LlamaParse client built from the resolved config."""

    # Private variables for internal use
    _parserLock: threading.Lock
    _parser: 'Parser'
    _llama_parse: 'LlamaParse'

    def beginGlobal(self):
        debug('LlamaParse Global: Starting global initialization')
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from llama_parse import LlamaParse

        from .parser import Parser

        bag = self.IEndpoint.endpoint.bag

        # The resolved config: the API key is required by the schema, the mode
        # selector decides which leaves are present
        config = self.config

        # Set up the lock for thread safety
        self._parserLock = threading.Lock()

        # Initialize the parser with the full configuration
        self._parser = Parser(self.glb.logicalType, config, bag)

        parser_args = {'verbose': False, 'api_key': config.api_key}
        if config.configMode == 'advanced':
            # The raw JSON block is merged into the constructor arguments. The
            # validator reports bad JSON at save time; here it stops the run so no
            # tokens are spent on an unintended configuration.
            try:
                advanced_config = json.loads(config.advanced_config or '{}')
            except json.JSONDecodeError as e:
                raise RuntimeError(f'LlamaParse Global: advanced configuration is not valid JSON: {e}') from e
            if not isinstance(advanced_config, dict):
                raise RuntimeError('LlamaParse Global: advanced configuration must be a JSON object')
            for key, value in advanced_config.items():
                if key != 'api_key':  # Don't override API key handling
                    parser_args[key] = value
        else:
            # Each parse mode branch declares only the leaves it sends, so a
            # leaf is read inside the branch that declares it
            parse_mode = config.parse_mode

            if parse_mode == 'cost_effective':
                parser_args['parse_mode'] = 'parse_page_with_llm'
            elif parse_mode in ('agentic', 'agentic_plus'):
                parser_args['parse_mode'] = 'parse_page_with_agent'
                parser_args['vendor_multimodal_model_name'] = config.lvm_model
            elif parse_mode == 'parse_page_with_lvm':
                # Legacy LVM mode with special parameters
                parser_args['parse_mode'] = parse_mode
                parser_args['vendor_multimodal_model_name'] = config.lvm_model
                system_prompt_append = (config.system_prompt_append or '').strip()
                if system_prompt_append:
                    parser_args['system_prompt_append'] = system_prompt_append
                parser_args['page_error_tolerance'] = 0.05

            if config.spreadsheet_extract_sub_tables:
                parser_args['spreadsheet_extract_sub_tables'] = True

        debug(f'LlamaParse Global: Creating LlamaParse instance with args: {list(parser_args)}')
        try:
            self._llama_parse = LlamaParse(**parser_args)
        except Exception as e:
            raise RuntimeError(f'LlamaParse Global: Error creating LlamaParse instance: {e}') from e

        # Store the LlamaParse instance in the bag for the parser to use
        bag['llama_parse'] = self._llama_parse
        debug('LlamaParse Global: LlamaParse initialized successfully')

        # Provenance advisory (issue #1406): this node emits flattened Markdown and
        # does not preserve cell-level provenance. Warn once at init so pipeline
        # authors building audit-grade extraction see it in the run logs. The
        # structure-preserving alternative is the datalab_parse node (#1425).
        warning(
            'LlamaParse Global: this node flattens documents to Markdown and does not preserve '
            'cell-level provenance (page boundaries, bbox coordinates, or the table-HTML cell grid). '
            'It is not suitable for audit-grade or provenance-bearing extraction. For structure-preserving '
            'parsing (HTML + tables with page/coordinates), use the datalab_parse node.'
        )

    def endGlobal(self):
        debug('LlamaParse Global: Starting global cleanup')
        # Clean up resources
        self._parser = None
        self._llama_parse = None
        debug('LlamaParse Global: Cleanup completed')
