# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Configuration Loading Utilities for RocketRide Pipeline Files.

This module provides utilities for loading and parsing RocketRide pipeline
configuration files with support for both JSON and JSON5 formats. Use these
functions to load pipeline configurations with comprehensive error handling,
format validation, and clear error reporting for configuration issues.

The configuration loader handles multiple JSON formats, provides detailed
error messages for parsing failures, and ensures robust file access with
proper exception handling for missing files and permission issues.

Key Features:
    - Support for both standard JSON and JSON5 formats
    - Comprehensive error handling with detailed error messages
    - File access validation with clear error reporting
    - Graceful fallback from JSON5 to JSON when library unavailable
    - UTF-8 encoding support for international character sets

Usage:
    config = load_pipeline_config("my_pipeline.json")

Components:
    load_pipeline_config: Main function for loading pipeline configurations
"""

import os
import json
from typing import Dict, Any

try:
    import json5
except ImportError:
    json5 = None


def load_pipeline_config(pipeline_file: str) -> Dict[str, Any]:
    """
    Load pipeline configuration from a .pipeline file.

    Reads and parses a pipeline configuration file supporting both JSON
    and JSON5 formats with comprehensive error handling and validation.

    Args:
        pipeline_file: Path to the pipeline configuration file

    Returns:
        Dict[str, Any]: Parsed pipeline configuration dictionary

    Raises:
        FileNotFoundError: If the specified pipeline file doesn't exist
        ValueError: If the file format is invalid or parsing fails

    Supported Formats:
        - JSON5 (if json5 library is available) - allows comments, trailing commas
        - Standard JSON - strict JSON format compliance
        - UTF-8 encoding for international character support

    Error Handling:
        - File existence validation with clear error messages
        - Format-specific parsing with detailed error information
        - Fallback from JSON5 to JSON if library unavailable
        - Comprehensive exception handling for file access issues

    Usage:
        ```python
        try:
            config = load_pipeline_config('my_pipeline.json')
            # Use configuration for pipeline setup
        except FileNotFoundError:
            print('Pipeline file not found')
        except ValueError as e:
            print(f'Configuration error: {e}')
        ```
    """
    if not os.path.isfile(pipeline_file):
        raise FileNotFoundError(f'Pipeline file not found: {pipeline_file}')

    try:
        with open(pipeline_file, 'r', encoding='utf-8') as f:
            content = f.read()

            if json5:
                try:
                    return json5.loads(content)
                except json5.JSONError as e:
                    raise ValueError(f'Invalid JSON5 format in {pipeline_file}: {e}')
            else:
                try:
                    return json.loads(content)
                except json.JSONDecodeError as e:
                    raise ValueError(f'Invalid JSON format in {pipeline_file}: {e}')

    except Exception as e:
        if isinstance(e, (FileNotFoundError, ValueError)):
            raise
        else:
            raise ValueError(f'Error reading {pipeline_file}: {e}')
