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
from typing import Any, Dict, List

from rocketlib import debug, warning


def _validate_path(path: str) -> str:
    """Validate and return the canonical path, raising ValueError if outside cwd.

    Resolves symlinks via os.path.realpath() and verifies the result lives
    under the current working directory. Also rejects raw '..' components
    before normalisation (they would be resolved away by realpath).
    """
    if '..' in path.replace('\\', '/').split('/'):
        raise ValueError(f'Path traversal detected in file path: {path}')

    real_path = os.path.realpath(path)
    real_cwd = os.path.realpath(os.getcwd())

    try:
        common = os.path.commonpath([real_path, real_cwd])
    except ValueError:
        raise ValueError(f'Path traversal detected: {path}') from None

    if common != real_cwd:
        raise ValueError(f'Path {path} is outside the working directory')

    return real_path


def _require_item_mappings(items: List[Any], source: str) -> List[Dict[str, Any]]:
    """Return ``items`` unchanged, or raise if any element is not a mapping.

    ``to_questions`` and ``apply_transforms`` call ``.get()`` on every item, so
    a scalar element raises an opaque ``AttributeError`` deep in the pipeline,
    which the node's boundaries turn into a bare warning and an empty dataset.
    Failing here names the offending index and the source instead.

    Args:
        items: Parsed dataset items to check.
        source: Human-readable origin (a file path, or 'inline items') used in
            the error message.

    Returns:
        The same list, when every element is a dict.

    Raises:
        ValueError: If any element is not a dict.
    """
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(
                f'Dataset item at index {idx} in {source} is not an object '
                f'(got {type(item).__name__}); each item must be a mapping.'
            )
    return items


class DatasetLoader:
    """Loads and transforms evaluation datasets using Cobalt AI's Dataset class.

    Supports JSON, CSV, and JSONL file formats as well as inline item lists.
    Provides chainable transformations including filter, sample, and slice.
    """

    def __init__(self, config: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the DatasetLoader with configuration.

        Args:
            config: Node configuration containing source_type, file_path, etc.
            bag: Shared endpoint bag for cross-node state.
        """
        self._config = config
        self._bag = bag
        self._source_type = config.get('source_type', 'file')
        self._file_path = config.get('file_path', '')
        self._sample_size = config.get('sample_size', 0)
        self._items = config.get('items', [])
        self._dataset = None

    def load(self) -> List[Dict[str, Any]]:
        """Load dataset based on configured source type.

        Returns:
            List of dataset item dicts.

        Raises:
            FileNotFoundError: If the configured file path does not exist.
            ValueError: If the file format is unsupported or dataset is empty.
        """
        if self._source_type == 'inline':
            return self.load_from_items(self._items)
        else:
            return self.load_from_file(self._file_path)

    def load_from_file(self, path: str) -> List[Dict[str, Any]]:
        """Load a dataset from a JSON, CSV, or JSONL file.

        Args:
            path: File path that must resolve to a location inside the current
                working directory. Paths outside it, or containing traversal
                sequences ('..'), are rejected by ``_validate_path``.

        Returns:
            List of dataset item dicts.

        Raises:
            FileNotFoundError: If the file does not exist.
            ValueError: If the file extension is unsupported or path contains traversal.
        """
        # Validate path: resolves symlinks and ensures it's under cwd.
        normalized = _validate_path(path)

        if not os.path.isfile(normalized):
            raise FileNotFoundError(f'Dataset file not found: {normalized}')

        ext = os.path.splitext(normalized)[1].lower()
        if ext not in ('.json', '.csv', '.jsonl'):
            raise ValueError(f'Unsupported file format: {ext}. Supported: .json, .csv, .jsonl')

        debug(f'Cobalt DatasetLoader: Loading file {normalized} with extension {ext}')

        # cobalt is optional: when basalt-ai-cobalt is not installed, parse the
        # file with a pure-Python fallback so the node stays functional instead
        # of silently yielding an empty dataset.
        try:
            from cobalt import Dataset
        except ImportError:
            debug('Cobalt DatasetLoader: basalt-ai-cobalt not installed, using Python fallback for file load')
            items = self._load_from_file_fallback(normalized, ext)
        else:
            if ext == '.jsonl':
                dataset = Dataset.from_jsonl(normalized)
            else:
                dataset = Dataset.from_file(normalized)
            items = list(dataset)

        debug(f'Cobalt DatasetLoader: Loaded {len(items)} items from file')

        if not items:
            warning('Cobalt DatasetLoader: File loaded but dataset is empty')

        return items

    @staticmethod
    def _load_from_file_fallback(path: str, ext: str) -> List[Dict[str, Any]]:
        """Parse a dataset file without the cobalt dependency.

        Mirrors cobalt.Dataset's file loaders for the supported formats so the
        node remains usable when basalt-ai-cobalt is not installed:
          - .jsonl: one JSON object per non-empty line
          - .json:  a JSON array, a ``{"items"|"data"|"rows": [...]}`` envelope,
                    or a single object wrapped into a one-item list
          - .csv:   csv.DictReader rows

        Args:
            path: Validated, existing file path.
            ext: Lowercased file extension (one of .json, .csv, .jsonl).

        Returns:
            List of dataset item dicts.

        Raises:
            ValueError: If the file is malformed or an item is not an object.
        """
        import json

        def _check_items(items: List[Any]) -> List[Dict[str, Any]]:
            return _require_item_mappings(items, path)

        # utf-8-sig transparently strips a UTF-8 BOM (common in Excel CSV and
        # Windows-authored JSON) and is correct for BOM-less files too; plain
        # utf-8 would fail on a BOM and be swallowed into an empty dataset.
        if ext == '.jsonl':
            items: List[Dict[str, Any]] = []
            with open(path, encoding='utf-8-sig') as fh:
                for lineno, line in enumerate(fh, start=1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        items.append(json.loads(stripped))
                    except json.JSONDecodeError as e:
                        raise ValueError(f'Invalid JSON in {path} line {lineno}: {e}') from e
            return _check_items(items)

        if ext == '.json':
            with open(path, encoding='utf-8-sig') as fh:
                try:
                    data = json.load(fh)
                except json.JSONDecodeError as e:
                    raise ValueError(f'Invalid JSON in {path}: {e}') from e
            if isinstance(data, list):
                return _check_items(data)
            if isinstance(data, dict):
                for key in ('items', 'data', 'rows'):
                    if isinstance(data.get(key), list):
                        return _check_items(data[key])
                return [data]
            raise ValueError(f'Unsupported JSON structure in {path}: expected an array or object')

        import csv

        with open(path, newline='', encoding='utf-8-sig') as fh:
            return [dict(row) for row in csv.DictReader(fh)]

    def load_from_items(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Load a dataset from an inline list of item dicts.

        Args:
            items: List of dicts, each representing a dataset item.

        Returns:
            List of dataset item dicts.

        Raises:
            ValueError: If items is empty or not a list.
        """
        # Parse JSON string from textarea input (services.json sends a string
        # when the field type is textarea).
        if isinstance(items, str):
            import json

            try:
                items = json.loads(items)
            except json.JSONDecodeError as e:
                raise ValueError(f'Failed to parse inline items as JSON: {e}') from e

        if not items or not isinstance(items, list):
            raise ValueError('Inline items must be a non-empty list of dicts')

        # Same guard the file paths apply: a scalar element would otherwise
        # surface as an opaque AttributeError from to_questions, which the node
        # boundary swallows into a bare warning and an empty dataset.
        items = _require_item_mappings(items, 'inline items')

        debug(f'Cobalt DatasetLoader: Loading {len(items)} inline items')

        # cobalt is optional: inline items are already Python dicts, so fall
        # back to returning them directly when the dependency is absent.
        try:
            from cobalt import Dataset
        except ImportError:
            debug('Cobalt DatasetLoader: basalt-ai-cobalt not installed, using inline items directly')
            return list(items)

        dataset = Dataset.from_items(items)
        return list(dataset)

    def apply_transforms(self, items: List[Dict[str, Any]], config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Apply filter, sample, and slice transformations to dataset items.

        Transformations are applied in order: filter -> sample -> slice.
        Each step is optional and controlled by config values.

        When basalt-ai-cobalt is installed, its Dataset class is used for transforms.
        Otherwise, a pure-Python fallback handles filter/sample/slice without
        requiring the cobalt dependency.

        Args:
            items: List of dataset item dicts to transform.
            config: Configuration with optional keys:
                - filter_field: Field name to filter on.
                - filter_value: Value that filter_field must match.
                - sample_size: Number of random items to sample (0 = skip).
                - slice_start: Start index for slicing.
                - slice_end: End index for slicing.

        Returns:
            Transformed list of dataset item dicts.
        """
        if not items:
            return items

        try:
            from cobalt import Dataset

            return self._apply_transforms_cobalt(items, config, Dataset)
        except ImportError:
            debug('Cobalt DatasetLoader: basalt-ai-cobalt not installed, using Python fallback for transforms')
            return self._apply_transforms_fallback(items, config)

    def _apply_transforms_cobalt(
        self, items: List[Dict[str, Any]], config: Dict[str, Any], Dataset: Any
    ) -> List[Dict[str, Any]]:
        """Apply transforms using cobalt's Dataset class."""
        dataset = Dataset.from_items(items)

        # Apply filter if configured
        filter_field = config.get('filter_field', '')
        filter_value = config.get('filter_value', '')
        if filter_field and filter_value:
            debug(f'Cobalt DatasetLoader: Filtering on {filter_field}={filter_value}')
            dataset = dataset.filter(lambda x, ff=filter_field, fv=filter_value: str(x.get(ff, '')) == str(fv))

        # Apply sample if configured, bounded to dataset size
        sample_size = int(config.get('sample_size', 0))
        if sample_size > 0:
            current_items = list(dataset)
            bounded_size = min(sample_size, len(current_items))
            debug(
                f'Cobalt DatasetLoader: Sampling {bounded_size} items (requested {sample_size}, available {len(current_items)})'
            )
            if bounded_size > 0:
                dataset = dataset.sample(bounded_size)

        # Apply slice if configured
        slice_start = int(config.get('slice_start', 0))
        slice_end = int(config.get('slice_end', 0))
        if slice_end > slice_start:
            debug(f'Cobalt DatasetLoader: Slicing [{slice_start}:{slice_end}]')
            dataset = dataset.slice(slice_start, slice_end)

        result = list(dataset)
        debug(f'Cobalt DatasetLoader: After transforms, {len(result)} items remain')
        return result

    def _apply_transforms_fallback(self, items: List[Dict[str, Any]], config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Apply transforms using pure Python (no cobalt dependency required)."""
        import random

        result = list(items)

        # Apply filter if configured
        filter_field = config.get('filter_field', '')
        filter_value = config.get('filter_value', '')
        if filter_field and filter_value:
            debug(f'Cobalt DatasetLoader: Filtering on {filter_field}={filter_value} (fallback)')
            result = [x for x in result if str(x.get(filter_field, '')) == str(filter_value)]

        # Apply sample if configured, bounded to dataset size
        sample_size = int(config.get('sample_size', 0))
        if sample_size > 0:
            bounded_size = min(sample_size, len(result))
            debug(f'Cobalt DatasetLoader: Sampling {bounded_size} items (fallback)')
            if bounded_size > 0 and bounded_size < len(result):
                result = random.sample(result, bounded_size)

        # Apply slice if configured
        slice_start = int(config.get('slice_start', 0))
        slice_end = int(config.get('slice_end', 0))
        if slice_end > slice_start:
            debug(f'Cobalt DatasetLoader: Slicing [{slice_start}:{slice_end}] (fallback)')
            result = result[slice_start:slice_end]

        debug(f'Cobalt DatasetLoader: After transforms (fallback), {len(result)} items remain')
        return result

    def to_questions(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert dataset items to RocketRide Question-compatible dicts.

        Each item is mapped to a dict with 'text' and 'metadata' fields
        suitable for constructing Question objects in the pipeline.

        Args:
            items: List of dataset item dicts.

        Returns:
            List of Question-compatible dicts with 'text' and 'metadata' keys.
        """
        questions = []
        for item in items:
            # Use None-aware fallback so that explicit empty strings or
            # falsy values (e.g. 0) from earlier fields are not skipped
            # in favour of later fields.
            text = next(
                (v for v in (item.get('input'), item.get('text'), item.get('question')) if v is not None),
                '',
            )
            expected = next(
                (v for v in (item.get('expected'), item.get('output'), item.get('answer')) if v is not None),
                '',
            )
            metadata = {
                'expected': expected,
                'dataset_id': item.get('id') or '',
                'cobalt_source': True,
            }
            # Preserve any extra fields from the original item as metadata
            for key, value in item.items():
                if key not in ('input', 'text', 'question', 'expected', 'output', 'answer', 'id'):
                    metadata[key] = value

            questions.append({'text': str(text), 'metadata': metadata})

        debug(f'Cobalt DatasetLoader: Converted {len(questions)} items to questions')
        return questions
