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
RocketRide CLI Pipeline Validation Command Implementation.

This module provides the ValidateCommand class for validating one or more
pipeline configuration files against the RocketRide server without executing
them. Use this command to check pipeline structure, component compatibility,
and connection integrity before deployment, either interactively or from CI.

The validate command expands shell-style glob patterns in-CLI (so behavior is
identical on shells that do not expand globs, e.g. Windows), parses each file
as JSON, and sends each parsed pipeline to the server's rrext_validate command
via the SDK validate() method.

Key Features:
    - Validate one or more .pipe files in a single invocation
    - In-CLI glob expansion for cross-platform wildcard support
    - Optional source component override via --source
    - Human-readable per-file output plus summary
    - Machine-readable output via --json for CI pipelines

Exit Codes:
    0: All files are valid
    1: At least one file failed validation
    2: Usage error, connection failure, or no file could be processed at all
       (a file counts as processed only when the server returns a validation
       verdict for it)

Usage:
    rocketride validate my_pipeline.pipe --apikey <key>
    rocketride validate examples/*.pipe --source webhook_1 --json

Components:
    ValidateCommand: Main command implementation for pipeline validation
"""

import glob
import json
import os
import sys
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from .base import BaseCommand
from ..ui.colors import ANSI_GREEN, ANSI_RED, ANSI_RESET, ANSI_YELLOW, CHR_CHECK, CHR_CROSS

if TYPE_CHECKING:
    from ..main import RocketRideClient


class ValidateCommand(BaseCommand):
    """
    Command implementation for validating pipeline configuration files.

    Expands file arguments (including glob patterns), parses each file as
    JSON, and validates each parsed pipeline against the server using the
    SDK validate() method. Results are reported per file in human-readable
    or JSON format, with exit codes suitable for CI usage.

    Example:
        ```python
        # Initialize and execute validate command
        command = ValidateCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - Multi-file validation with in-CLI glob expansion
        - Optional --source override passed through to the server
        - Human-readable and JSON output formats
        - Exit codes: 0 all valid, 1 any invalid, 2 nothing processable
    """

    def __init__(self, cli, args):
        """
        Initialize ValidateCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing files and options
        """
        super().__init__(cli, args)

    def _expand_files(self, patterns: List[str]) -> List[str]:
        """
        Expand file arguments into a deduplicated, ordered list of paths.

        Literal paths are kept as-is; anything else is treated as a glob
        pattern (expanded in-CLI so wildcards work on shells that do not
        expand them). Patterns that match nothing are kept verbatim so they
        can be reported as unreadable files.

        Args:
            patterns: File paths and/or glob patterns from the command line

        Returns:
            List[str]: Expanded file paths, deduplicated, preserving order
        """
        expanded: List[str] = []
        for pattern in patterns:
            if os.path.isfile(pattern):
                expanded.append(pattern)
                continue

            # Not a literal file - try shell-style glob expansion
            matches = sorted(path for path in glob.glob(pattern, recursive=True) if os.path.isfile(path))
            if matches:
                expanded.extend(matches)
            else:
                # Keep the unmatched pattern so it is reported per-file below
                expanded.append(pattern)

        # Remove duplicates while preserving order
        seen = set()
        unique_files = []
        for file_path in expanded:
            if file_path not in seen:
                seen.add(file_path)
                unique_files.append(file_path)
        return unique_files

    def _load_pipeline(self, file_path: str) -> Dict[str, Any]:
        """
        Load and parse a pipeline configuration file as strict JSON.

        ``.pipe`` files may wrap the configuration in ``{"pipeline": {...}}``;
        the inner object is extracted when present, mirroring the SDK's use()
        loader and the TypeScript CLI.

        Args:
            file_path: Path to the pipeline configuration file

        Returns:
            Dict[str, Any]: Parsed pipeline configuration

        Raises:
            ValueError: If the file cannot be read, is not valid JSON, or its
                top-level value is not a JSON object
        """
        if not os.path.isfile(file_path):
            raise ValueError(f'File not found: {file_path}')

        try:
            with open(file_path, 'r', encoding='utf-8') as handle:
                parsed = json.load(handle)
        except json.JSONDecodeError as err:
            raise ValueError(f'Invalid JSON in {file_path}: {err}') from err
        except OSError as err:
            raise ValueError(f'Cannot read {file_path}: {err}') from err

        if not isinstance(parsed, dict):
            raise ValueError(f'Invalid pipeline format in {file_path}: expected a JSON object')

        # .pipe files wrap the config in { "pipeline": { ... } } - unwrap if present
        inner = parsed.get('pipeline')
        return inner if isinstance(inner, dict) else parsed

    def _print_human(self, results: List[Dict[str, Any]], summary: Dict[str, int]) -> None:
        """
        Print per-file validation results and a summary in human format.

        Args:
            results: Per-file result entries (file, valid, errors, warnings)
            summary: Aggregate counts (total, valid, invalid)
        """
        for entry in results:
            if entry['valid']:
                print(f'{ANSI_GREEN}{CHR_CHECK}{ANSI_RESET} {entry["file"]}: valid')
            else:
                print(f'{ANSI_RED}{CHR_CROSS}{ANSI_RESET} {entry["file"]}: invalid')

            # Show every error with its component id when available
            for error in entry['errors']:
                message = error.get('message', str(error)) if isinstance(error, dict) else str(error)
                component = error.get('id') if isinstance(error, dict) else None
                suffix = f' ({component})' if component else ''
                print(f'    {ANSI_RED}error{ANSI_RESET}: {message}{suffix}')

            # Show every warning with its component id when available
            for warning in entry['warnings']:
                message = warning.get('message', str(warning)) if isinstance(warning, dict) else str(warning)
                component = warning.get('id') if isinstance(warning, dict) else None
                suffix = f' ({component})' if component else ''
                print(f'    {ANSI_YELLOW}warning{ANSI_RESET}: {message}{suffix}')

        print()
        print(f'Summary: {summary["total"]} file(s), {summary["valid"]} valid, {summary["invalid"]} invalid')

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute the pipeline validation command.

        Expands file arguments, parses each file as JSON, validates each
        parsed pipeline against the server, and reports per-file results
        with a summary in either human-readable or JSON format.

        Args:
            client: RocketRideClient instance for server communication

        Returns:
            Exit code: 0 if all files are valid, 1 if at least one file
            failed validation, 2 if the server connection failed or no
            file could be processed at all (i.e. no file received a
            server validation verdict)

        Process Flow:
            1. Expand glob patterns and literal paths into a file list
            2. Parse each file as JSON, recording parse errors per file
            3. Connect to the server if any file parsed successfully
            4. Validate each parsed pipeline via the SDK validate() method
            5. Report per-file results and summary in the requested format
            6. Compute the exit code from the aggregate results
        """
        # Save the client for SDK calls
        self.client = client

        # Expand globs and literal paths into the working file list
        files = self._expand_files(self.args.files)

        # Parse each file up front; parse failures are per-file errors
        pipelines: Dict[str, Optional[Dict[str, Any]]] = {}
        parse_errors: Dict[str, str] = {}
        for file_path in files:
            try:
                pipelines[file_path] = self._load_pipeline(file_path)
            except ValueError as err:
                pipelines[file_path] = None
                parse_errors[file_path] = str(err)

        # Connect only if at least one file parsed successfully
        if any(config is not None for config in pipelines.values()):
            try:
                if not self.cli.client.is_connected():
                    await self.cli.connect()
            except Exception as err:
                print(f'Error: Unable to connect to server: {err}', file=sys.stderr)
                return 2

        # Validate each file in order, collecting per-file results
        results: List[Dict[str, Any]] = []
        processed = 0
        for file_path in files:
            config = pipelines[file_path]
            if config is None:
                # Unreadable or unparseable file - report as invalid
                results.append(
                    {
                        'file': file_path,
                        'valid': False,
                        'errors': [{'message': parse_errors[file_path]}],
                        'warnings': [],
                    }
                )
                continue

            try:
                # Pass through the optional --source override to the SDK
                result = await self.client.validate(config, source=self.args.source)
            except Exception as err:
                # Server rejected the request for this file
                results.append(
                    {
                        'file': file_path,
                        'valid': False,
                        'errors': [{'message': str(err)}],
                        'warnings': [],
                    }
                )
                continue

            errors = result.get('errors') or []
            warnings = result.get('warnings') or []
            results.append(
                {
                    'file': file_path,
                    'valid': not errors,
                    'errors': errors,
                    'warnings': warnings,
                }
            )
            processed += 1

        # Build the aggregate summary
        valid_count = sum(1 for entry in results if entry['valid'])
        summary = {
            'total': len(results),
            'valid': valid_count,
            'invalid': len(results) - valid_count,
        }

        # Emit results in the requested format
        if self.args.json:
            # Machine-readable output only - keep stdout pipeable
            print(json.dumps({'files': results, 'summary': summary}, indent=2))
        else:
            self._print_human(results, summary)

        # Exit 2 if no file could be processed at all
        if processed == 0:
            return 2

        # Exit 1 if any file is invalid, 0 if all files are valid
        return 0 if summary['invalid'] == 0 else 1
