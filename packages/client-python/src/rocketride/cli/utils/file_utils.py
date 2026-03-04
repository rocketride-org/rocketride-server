# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
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
File Discovery and Validation Utilities for RocketRide CLI.

This module provides utilities for discovering files from patterns, wildcards,
and directories, plus validation functions to ensure files are accessible
before processing. Use these functions to handle complex file discovery
scenarios with comprehensive validation and error reporting.

The file utilities support various input patterns including direct file paths,
wildcard patterns, and directory traversal with automatic deduplication,
accessibility testing, and detailed error reporting for problematic files.

Key Features:
    - Multi-pattern file discovery with wildcard and directory support
    - Recursive directory traversal for comprehensive file discovery
    - Automatic duplicate removal while preserving order
    - File accessibility validation with detailed error reporting
    - Cross-platform path handling and file system operations

Usage:
    files = find_files(["*.txt", "data/", "specific_file.json"])
    valid_files, invalid_files = validate_files(files)

Components:
    find_files: Discover files from patterns and directories
    validate_files: Validate file accessibility and permissions
"""

import os
import glob
from pathlib import Path
from typing import List, Tuple


def find_files(patterns: List[str]) -> List[str]:
    """
    Find all files matching the given patterns.

    Discovers files using multiple input patterns including direct file paths,
    wildcard patterns, and directory paths with recursive traversal.

    Args:
        patterns: List of file patterns, paths, or directories to search

    Returns:
        List[str]: Absolute paths of all discovered files (deduplicated)

    Pattern Types Supported:
        - Direct file paths: "path/to/file.txt"
        - Wildcard patterns: "*.txt", "data/**/*.json"
        - Directory paths: "my_directory" (recursively searches all files)

    Discovery Process:
        1. Check if pattern is a direct file path
        2. Check if pattern is a directory (recursive file discovery)
        3. Apply glob pattern matching for wildcards
        4. Convert all paths to absolute paths
        5. Remove duplicates while preserving order

    Usage:
        ```python
        # Mixed pattern discovery
        patterns = ['*.log', 'data/', 'config.json']
        files = find_files(patterns)

        # Process discovered files
        for file_path in files:
            print(f'Found: {file_path}')
        ```
    """
    files = []
    for pattern in patterns:
        path = Path(pattern)
        if path.is_file():
            files.append(str(path.absolute()))
        elif path.is_dir():
            for file_path in path.rglob('*'):
                if file_path.is_file():
                    files.append(str(file_path.absolute()))
        else:
            matched_files = glob.glob(pattern, recursive=True)
            for matched_file in matched_files:
                if os.path.isfile(matched_file):
                    files.append(str(Path(matched_file).absolute()))

    # Remove duplicates while preserving order
    seen = set()
    unique_files = []
    for file_path in files:
        if file_path not in seen:
            seen.add(file_path)
            unique_files.append(file_path)
    return unique_files


def validate_files(files_list: List[str]) -> Tuple[List[str], List[str]]:
    """
    Validate that all files exist and are accessible.

    Tests file accessibility by checking existence and attempting to read
    the first byte of each file to ensure permissions and availability.

    Args:
        files_list: List of file paths to validate

    Returns:
        Tuple[List[str], List[str]]: (valid_files, error_messages)

    Validation Tests:
        1. File existence check using os.path.isfile()
        2. Read accessibility test by opening and reading first byte
        3. Error categorization with descriptive messages

    Error Categories:
        - File not found: Path doesn't exist or isn't a file
        - Permission denied: File exists but cannot be read
        - Other OS errors: Disk issues, network problems, etc.

    Usage:
        ```python
        # Validate discovered files
        all_files = find_files(patterns)
        valid_files, errors = validate_files(all_files)

        # Handle validation results
        if errors:
            print('Validation errors:')
            for error in errors:
                print(f'  - {error}')

        # Process valid files
        for file_path in valid_files:
            # File is guaranteed to be readable
            process_file(file_path)
        ```
    """
    valid_files = []
    invalid_files = []

    for filepath in files_list:
        if os.path.isfile(filepath):
            try:
                with open(filepath, 'rb') as f:
                    f.read(1)
                valid_files.append(filepath)
            except OSError as e:
                invalid_files.append(f'Cannot read {Path(filepath).name}: {e}')
        else:
            invalid_files.append(f'File not found: {Path(filepath).name}')

    return valid_files, invalid_files
