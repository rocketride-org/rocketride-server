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
import threading
from typing import TYPE_CHECKING
from rocketlib import IGlobalBase, debug, warning
from ai.common.config import Config

_SENSITIVE_KEYS = ('api_key', 'apikey', 'secret', 'token', 'password', 'credential')


def _redact_dict(d: dict) -> dict:
    """Return a copy of *d* with sensitive values replaced by '***REDACTED***'."""
    return {k: ('***REDACTED***' if any(p in k.lower() for p in _SENSITIVE_KEYS) else v) for k, v in d.items()}


if TYPE_CHECKING:
    from .parser import Parser
    from llama_parse import LlamaParse


class IGlobal(IGlobalBase):
    # Private variables for internal use
    _parserLock: threading.Lock
    _parser: 'Parser'
    _llama_parse: 'LlamaParse'

    def validateConfig(self):
        """Validate LlamaParse configuration at save-time.

        Checks for valid JSON in advanced_config and other configuration issues.
        """
        try:
            # Get this node's config
            config = self._extractConfig()

            # Check if advanced configuration is enabled
            use_advanced_config = config.get('use_advanced_config', False)

            if use_advanced_config:
                # Validate advanced JSON configuration
                advanced_config_str = config.get('advanced_config', '{}')
                if advanced_config_str and advanced_config_str.strip():
                    try:
                        import json

                        advanced_config = json.loads(advanced_config_str)

                        # Additional validation: check for known LlamaParse parameters
                        valid_params = {'parse_mode', 'vendor_multimodal_model_name', 'system_prompt_append', 'page_error_tolerance', 'spreadsheet_extract_sub_tables', 'verbose'}

                        invalid_params = [key for key in advanced_config.keys() if key not in valid_params]
                        if invalid_params:
                            warning(f'LlamaParse Global: Advanced config contains unknown parameters: {invalid_params}')

                    except json.JSONDecodeError as e:
                        warning(f'LlamaParse Global: Advanced configuration contains invalid JSON: {str(e)}')
                        warning('LlamaParse Global: Please fix the JSON syntax or remove the advanced configuration.')
                        return  # Return to indicate validation failure

            # Check API key configuration
            api_key = config.get('api_key')
            if not api_key:
                warning('LlamaParse Global: No API key provided in configuration.')
                return  # Return to indicate validation failure

        except Exception as e:
            warning(f'LlamaParse Global: Configuration validation error: {str(e)}')
            return  # Return to indicate validation failure

    def beginGlobal(self):
        debug('LlamaParse Global: Starting global initialization')
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        debug(f'LlamaParse Global: Loading requirements from {requirements}')
        depends(requirements)

        # Import what we need
        debug('LlamaParse Global: Importing parser module')
        from .parser import Parser

        debug('LlamaParse Global: Importing LlamaParse library')
        from llama_parse import LlamaParse

        # Get our bag
        bag = self.IEndpoint.endpoint.bag
        debug('LlamaParse Global: Retrieved endpoint bag')

        # Get this node's config
        config = self._extractConfig()
        debug(f'LlamaParse Global: Retrieved node config for {self.glb.logicalType}')
        debug(f'LlamaParse Global: Config contains: {list(config.keys())}')

        # Set up the lock for thread safety
        debug('LlamaParse Global: Creating thread lock for parser')
        self._parserLock = threading.Lock()

        # Initialize the parser with the full configuration
        debug('LlamaParse Global: Initializing parser')
        self._parser = Parser(self.glb.logicalType, self.glb.connConfig, bag)

        # Get API key from user configuration
        api_key = config.get('api_key')
        if api_key:
            debug(f'LlamaParse Global: Using user-provided API key: {api_key[:10]}...')
        else:
            warning('LlamaParse Global: No API key provided in configuration.')
            api_key = None

        # Build LlamaParse constructor arguments
        parser_args = {'verbose': False}  # Use minimal verbose setting

        # Add API key if available
        if api_key:
            parser_args['api_key'] = api_key
        else:
            # If we reach here without an API key, something went wrong with validation
            error_msg = 'LlamaParse Global: Critical configuration error - no valid API key available'
            warning(error_msg)
            warning('LlamaParse Global: Aborting execution to prevent API errors. Please fix configuration and retry.')
            raise RuntimeError(error_msg)

        # Check if advanced configuration is enabled
        use_advanced_config = config.get('use_advanced_config', False)

        if use_advanced_config:
            # Handle advanced JSON configuration
            advanced_config_str = config.get('advanced_config', '{}')
            if not advanced_config_str or not advanced_config_str.strip():
                error_msg = 'LlamaParse Global: Critical configuration error - advanced config enabled but no configuration provided'
                warning(error_msg)
                warning('LlamaParse Global: Aborting execution. Please provide advanced configuration or disable advanced config mode.')
                raise RuntimeError(error_msg)

            try:
                import json

                advanced_config = json.loads(advanced_config_str) if advanced_config_str else {}
                debug(f'LlamaParse Global: Using advanced config: {advanced_config}')

                # Merge advanced config into parser_args (excluding api_key which is handled above)
                for key, value in advanced_config.items():
                    if key != 'api_key':  # Don't override API key handling
                        parser_args[key] = value

            except json.JSONDecodeError as e:
                error_msg = f'LlamaParse Global: Critical configuration error - advanced config JSON parsing failed: {str(e)}'
                warning(error_msg)
                warning('LlamaParse Global: Aborting execution to prevent unintended token usage. Please fix configuration and retry.')
                raise RuntimeError(error_msg)  # Abort execution to prevent token waste
        else:
            # Handle simple configuration (existing logic)
            # Get parse mode and related configuration
            parse_mode = config.get('parse_mode', None)
            lvm_model = config.get('lvm_model', None)
            system_prompt_append = config.get('system_prompt_append', None)
            spreadsheet_extract_sub_tables = config.get('spreadsheet_extract_sub_tables', False)

            # Handle different parse modes
            if parse_mode:
                if parse_mode in ['cost_effective']:
                    # Standard LlamaParse modes
                    parser_args['parse_mode'] = 'parse_page_with_llm'
                elif parse_mode in ['agentic', 'agentic_plus']:
                    parser_args['parse_mode'] = 'parse_page_with_agent'
                    # Set LVM model for agentic modes if provided
                    if lvm_model:
                        parser_args['vendor_multimodal_model_name'] = lvm_model

                elif parse_mode == 'parse_page_with_lvm':
                    # Legacy LVM mode with special parameters
                    parser_args['parse_mode'] = parse_mode
                    if lvm_model:
                        parser_args['vendor_multimodal_model_name'] = lvm_model
                    if system_prompt_append and system_prompt_append.strip():
                        parser_args['system_prompt_append'] = system_prompt_append.strip()
                    parser_args['page_error_tolerance'] = 0.05
                elif parse_mode == 'parse_page_with_llm':
                    # Legacy LLM mode
                    parser_args['parse_mode'] = parse_mode

            if spreadsheet_extract_sub_tables:
                parser_args['spreadsheet_extract_sub_tables'] = spreadsheet_extract_sub_tables

        debug(f'LlamaParse Global: Creating LlamaParse instance with args: {_redact_dict(parser_args)}')
        try:
            debug(f'LlamaParse Global: Creating LlamaParse instance with args: {_redact_dict(parser_args)}')
            self._llama_parse = LlamaParse(**parser_args)
            debug('LlamaParse Global: LlamaParse instance created successfully')
        except Exception as e:
            warning(f'LlamaParse Global: Error creating LlamaParse instance: {str(e)}')
            self._llama_parse = None

        # Store the LlamaParse instance in the bag for the parser to use
        if self._llama_parse:
            bag['llama_parse'] = self._llama_parse
            debug('LlamaParse Global: LlamaParse initialized successfully')
        else:
            error_msg = 'LlamaParse Global: Critical error - failed to initialize LlamaParse instance'
            warning(error_msg)
            warning('LlamaParse Global: Aborting execution. Please check configuration and retry.')
            raise RuntimeError(error_msg)

    def _extractConfig(self):
        """Extract and validate node configuration.

        Returns the processed config dictionary.
        """
        # Get this node's current config from the endpoint
        # to ensure we have the most up-to-date configuration
        current_conn_config = getattr(self.IEndpoint.endpoint, 'connConfig', self.glb.connConfig)
        config = Config.getNodeConfig(self.glb.logicalType, current_conn_config)

        # Check if config has nested structure
        if 'default' in config:
            config = config.get('default', {})

        return config

    def endGlobal(self):
        debug('LlamaParse Global: Starting global cleanup')
        # Clean up resources
        self._parser = None
        self._llama_parse = None
        debug('LlamaParse Global: Cleanup completed')
