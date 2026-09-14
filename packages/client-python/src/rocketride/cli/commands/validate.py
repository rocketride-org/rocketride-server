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
``validate`` — check pipeline files against the server without executing them.

Expands shell-style glob patterns in-CLI (so behavior is identical on shells
that do not expand globs, e.g. Windows), parses each file as strict JSON, and
sends each parsed pipeline to the server via the SDK ``validate()`` method.
Kept in exact parity with the TypeScript CLI's ``src/cli/commands/validate.ts``.

Exit codes (the ``validate-pipes`` GitHub Action depends on these):
    0: All files are valid
    1: At least one file failed validation
    2: Usage error, connection failure, or no file could be processed at all
       (a file counts as processed only when the server returns a validation
       verdict for it)
"""

import glob
import json
import os
import sys
from typing import Any, Dict, List, Optional

from ..utils.common import connect_client, run_cli_command
from ..utils.output import Output


def _expand_files(patterns: List[str]) -> List[str]:
    """
    Expand file arguments into a deduplicated, ordered list of paths.

    Literal paths are kept as-is; anything else is treated as a glob pattern.
    Patterns that match nothing are kept verbatim so they can be reported as
    unreadable files.

    Args:
        patterns: File paths and/or glob patterns from the command line.

    Returns:
        Expanded file paths, deduplicated, preserving order.
    """
    expanded: List[str] = []
    for pattern in patterns:
        if os.path.isfile(pattern):
            expanded.append(pattern)
            continue
        # Not a literal file — try shell-style glob expansion
        matches = sorted(path for path in glob.glob(pattern, recursive=True) if os.path.isfile(path))
        if matches:
            expanded.extend(matches)
        else:
            # Keep the unmatched pattern so it is reported per-file below
            expanded.append(pattern)

    # step: dedupe while preserving order
    seen = set()
    unique_files = []
    for file_path in expanded:
        if file_path not in seen:
            seen.add(file_path)
            unique_files.append(file_path)
    return unique_files


def _load_pipeline(file_path: str) -> Dict[str, Any]:
    """
    Load and parse a pipeline configuration file as strict JSON.

    ``.pipe`` files may wrap the configuration in ``{"pipeline": {...}}``;
    the inner object is extracted when present, mirroring the SDK's use()
    loader and the TypeScript CLI.

    Args:
        file_path: Path to the pipeline configuration file.

    Returns:
        Parsed pipeline configuration.

    Raises:
        ValueError: If the file cannot be read, is not valid JSON, or its
            top-level value is not a JSON object.
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

    # .pipe files wrap the config in { "pipeline": { ... } } — unwrap if present
    inner = parsed.get('pipeline')
    return inner if isinstance(inner, dict) else parsed


def _entry_lines(entry: Dict[str, Any], out: Output) -> None:
    """
    Emit one file's verdict with its errors and warnings.

    Args:
        entry: Per-file result (file, valid, errors, warnings).
        out: The command's output channel.
    """
    out.line(f'{entry["file"]}: {"valid" if entry["valid"] else "invalid"}')
    for kind, items in (('error', entry['errors']), ('warning', entry['warnings'])):
        for item in items:
            message = item.get('message', str(item)) if isinstance(item, dict) else str(item)
            component = item.get('id') if isinstance(item, dict) else None
            suffix = f' ({component})' if component else ''
            out.line(f'    {kind}: {message}{suffix}')


async def run_validate(args) -> int:
    """
    Validate one or more pipeline files and report per-file results.

    Args:
        args: Parsed argparse namespace (files, source, uri, apikey, json).

    Returns:
        Exit code (0 all valid / 1 any invalid / 2 nothing processed).
    """

    async def action(out: Output) -> int:
        # step: expand globs and literal paths into the working file list
        files = _expand_files(args.files)

        # step: parse every file up front; parse failures are per-file errors
        pipelines: Dict[str, Optional[Dict[str, Any]]] = {}
        parse_errors: Dict[str, str] = {}
        for file_path in files:
            try:
                pipelines[file_path] = _load_pipeline(file_path)
            except ValueError as err:
                pipelines[file_path] = None
                parse_errors[file_path] = str(err)

        # step: connect only if at least one file parsed. A connection failure
        # is exit code 2 by contract, so it is handled HERE — the shared
        # runner's catch-all would turn it into a 1.
        client = None
        if any(config is not None for config in pipelines.values()):
            try:
                client = await connect_client(args.uri, args.apikey)
            except Exception as err:  # noqa: BLE001
                print(f'Error: Unable to connect to server: {err}', file=sys.stderr)
                return 2

        # step: validate each file in order, collecting per-file results
        results: List[Dict[str, Any]] = []
        processed = 0
        for file_path in files:
            config = pipelines[file_path]
            if config is None:
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
                result = await client.validate(config, source=args.source)
            except Exception as err:  # noqa: BLE001
                # The server rejected the request for this file — reported
                # per-file, but it does NOT count as processed.
                results.append({'file': file_path, 'valid': False, 'errors': [{'message': str(err)}], 'warnings': []})
                continue

            errors = result.get('errors') or []
            warnings = result.get('warnings') or []
            results.append({'file': file_path, 'valid': not errors, 'errors': errors, 'warnings': warnings})
            processed += 1

        # step: aggregate summary + report (out.line is human-only; the JSON
        # payload carries the same shape the old CLI and the TS CLI emit)
        valid_count = sum(1 for entry in results if entry['valid'])
        summary = {'total': len(results), 'valid': valid_count, 'invalid': len(results) - valid_count}
        for entry in results:
            _entry_lines(entry, out)
        out.line('')
        out.line(f'Summary: {summary["total"]} file(s), {summary["valid"]} valid, {summary["invalid"]} invalid')
        out.result({'files': results, 'summary': summary})

        # step: exit code per the CI contract
        if processed == 0:
            return 2
        return 0 if summary['invalid'] == 0 else 1

    return await run_cli_command(args, action)
