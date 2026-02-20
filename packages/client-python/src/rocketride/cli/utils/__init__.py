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
CLI Utility Functions.

This module provides utility functions for the RocketRide CLI including pipeline
configuration loading, file discovery and validation, and formatting utilities
for human-readable output.

Utilities:
    load_pipeline_config: Load and parse pipeline configuration files (JSON, JSON5)
    find_files: Discover files from patterns, wildcards, and directories
    validate_files: Validate file accessibility and existence
    format_size: Format byte counts as human-readable sizes (KB, MB, GB)
    format_duration: Format time durations in human-readable formats
    truncate_filename: Truncate long filenames for display
"""

from .config import load_pipeline_config
from .file_utils import find_files, validate_files
from .formatters import format_size, format_duration, truncate_filename

__all__ = [
    'load_pipeline_config',
    'find_files',
    'validate_files',
    'format_size',
    'format_duration',
    'truncate_filename',
]
