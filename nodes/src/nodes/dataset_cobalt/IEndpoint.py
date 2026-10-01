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

import hashlib
import json
import os
from typing import Any, Callable, Dict, List
from urllib.parse import quote

from ai.common.config import Config
from rocketlib import IEndpointBase, debug, monitorCompleted, monitorStatus, warning

from .common import question_text, skipped_rows_warning


class IEndpoint(IEndpointBase):
    """Source endpoint for emitting Cobalt dataset rows into a pipeline."""

    target: IEndpointBase | None = None

    def scanObjects(self, _path: str, _scanCallback: Callable[[Dict[str, Any]], None]):
        """Load the configured dataset and emit each row as a Question.

        A dataset that legitimately holds no rows completes with a count of
        zero. A dataset that could not be *loaded* raises ``DatasetLoadError``
        out of this method, which the engine records as a failed scan: a
        typo'd ``file_path`` must not report a successful run that evaluated
        nothing.
        """
        questions = self._load_questions()
        if not questions:
            monitorStatus('Cobalt Dataset: no questions to emit')
            monitorCompleted(0)
            return

        monitorStatus(f'Cobalt Dataset: emitting {len(questions)} questions')

        for index, item in enumerate(questions, start=1):
            entry = self._entry_from_item(index, item)
            result = _scanCallback(entry)
            if result:
                debug(f'Cobalt Dataset Endpoint: scanner stopped at question {index} with result {result}')
                break
            monitorStatus(f'Cobalt Dataset: queued {index}/{len(questions)} questions')

        monitorCompleted(len(questions))

    def _load_questions(self) -> List[Dict[str, Any]]:
        """Return the prepared questions, or raise if the dataset cannot be read.

        Rows carrying no prompt text are dropped here rather than emitted as
        scan entries: filter mode applies the same rule in
        ``IInstance.writeQuestions``, and a promptless question downstream
        becomes a real-looking - but meaningless - evaluation score. Dropping
        them here also keeps the monitor count and the emitted entry count in
        step.

        Returns:
            The prepared question dicts. An empty list means the dataset was
            read successfully and holds no rows.

        Raises:
            DatasetLoadError: If the dataset could not be loaded at all.
        """
        self._installDriver()

        # Imported after the driver install so the loader picks up a freshly
        # installed cobalt; the module itself imports cobalt lazily, so this
        # still works when the install was skipped or failed.
        from .dataset_loader import DatasetLoader, DatasetLoadError

        config = self._extractConfig()
        debug(f'Cobalt Dataset Endpoint: Config keys: {list(config.keys())}')

        loader = DatasetLoader(config, self.endpoint.bag)
        try:
            items = loader.load()
            dataset = loader.apply_transforms(items, config)
            questions = loader.to_questions(dataset)
            emittable = [item for item in questions if question_text(item) is not None]
            skipped = len(questions) - len(emittable)
            if skipped:
                warning(f'Cobalt Dataset Endpoint: {skipped_rows_warning(skipped)}')
            debug(f'Cobalt Dataset Endpoint: Prepared {len(emittable)} questions')
            return emittable
        except ImportError as exc:
            warning(f'Cobalt Dataset Endpoint: Failed to import cobalt library: {exc!s}')
            raise DatasetLoadError(
                f'Cobalt Dataset Endpoint: failed to import the cobalt library: {exc!s}. '
                'Ensure basalt-ai-cobalt is installed: pip install basalt-ai-cobalt'
            ) from exc
        except (FileNotFoundError, ValueError) as exc:
            warning(f'Cobalt Dataset Endpoint: {exc!s}')
            raise DatasetLoadError(f'Cobalt Dataset Endpoint: {exc!s}') from exc
        # Broad by intent: every load failure leaves as one named type, so the
        # engine sees an error rather than a successful run over zero rows.
        except Exception as exc:
            warning(f'Cobalt Dataset Endpoint: Failed to prepare dataset: {exc!s}')
            raise DatasetLoadError(f'Cobalt Dataset Endpoint: failed to prepare dataset: {exc!s}') from exc

    def _installDriver(self) -> None:
        """Install the optional cobalt driver, tolerating an install failure.

        The node ships a pure-Python reader for every supported format (see
        ``DatasetLoader._load_from_file_fallback``), and the README promises
        it. Letting ``depends()`` raise here would make that promise
        unreachable: an unreachable index or a resolution conflict would abort
        the scan even though the node can do the whole job without the
        dependency.
        """
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        debug(f'Cobalt Dataset Endpoint: Loading requirements from {requirements}')
        # Broad by intent: any install failure degrades to the pure-Python reader.
        try:
            depends(requirements)
        except Exception as exc:
            warning(
                f'Cobalt Dataset Endpoint: could not install {requirements}: {exc!s}. '
                'Continuing with the pure-Python dataset reader.'
            )

    def _extractConfig(self) -> Dict[str, Any]:
        """Extract source config from the endpoint and normalize UI prefixes."""
        raw_config = self._resolveRawConfig()

        config = Config.getNodeConfig(self.endpoint.logicalType, raw_config)

        profile = config.get('profile')
        if isinstance(profile, str) and isinstance(config.get(profile), dict):
            nested_profile = config.get(profile, {})
            config = {k: v for k, v in config.items() if k not in {'profile', profile}}
            config.update(nested_profile)

        if isinstance(config.get('default'), dict):
            nested_default = config.get('default', {})
            config = {k: v for k, v in config.items() if k != 'default'}
            config.update(nested_default)

        normalized = {}
        prefixed = {}
        for key, value in config.items():
            if isinstance(key, str) and key.startswith('dataset.'):
                prefixed[key.removeprefix('dataset.')] = value
            else:
                normalized[key] = value
        normalized.update(prefixed)

        return normalized

    def _resolveRawConfig(self) -> Dict[str, Any]:
        candidates = [
            getattr(self.endpoint, 'serviceConfig', {}) or {},
            getattr(self.endpoint, 'parameters', {}) or {},
            self._sourceConfigFromTask(),
        ]

        fallback: Dict[str, Any] = {}
        for candidate in candidates:
            config = self._mergeSourceParameters(candidate)
            if not fallback and config:
                fallback = config
            if self._hasDatasetConfig(config):
                return config
        return fallback

    def _sourceConfigFromTask(self) -> Dict[str, Any]:
        task_config = getattr(self.endpoint, 'taskConfig', {}) or {}
        pipeline = self._get_dict_value(task_config, 'pipeline', {})
        source_id = self._get_dict_value(pipeline, 'source', '')
        components = self._get_dict_value(pipeline, 'components', [])
        for component in components or []:
            if self._get_dict_value(component, 'id', '') == source_id:
                return self._get_dict_value(component, 'config', {}) or {}
        return {}

    def _mergeSourceParameters(self, raw_config: Any) -> Dict[str, Any]:
        config = self._to_dict(raw_config)
        parameters = self._to_dict(config.get('parameters', {}))
        if parameters:
            config = {k: v for k, v in config.items() if k not in {'hideForm', 'mode', 'type', 'parameters'}}
            config.update(parameters)
        return config

    def _hasDatasetConfig(self, config: Dict[str, Any]) -> bool:
        return any(
            key in config
            for key in (
                'profile',
                'source_type',
                'items',
                'file_path',
                'dataset.source_type',
                'dataset.items',
                'inline',
                'file',
            )
        )

    def _get_dict_value(self, value: Any, key: str, default: Any = None) -> Any:
        try:
            return value.get(key, default)
        except AttributeError:
            return default

    def _to_dict(self, value: Any) -> Dict[str, Any]:
        if isinstance(value, dict):
            return dict(value)
        try:
            return {key: value[key] for key in value.keys()}
        except Exception:
            try:
                return dict(value)
            except Exception:
                return {}

    def _entry_from_item(self, index: int, item: Dict[str, Any]) -> Dict[str, Any]:
        raw_text = item.get('text', '')
        text = str(raw_text) if raw_text is not None and raw_text != '' else f'Cobalt dataset item {index}'

        return {
            'url': f'dataset_cobalt://{index}/{self._identity_for_item(item)}',
            'name': text[:200],
            'isContainer': False,
            'size': len(text.encode('utf-8')),
            'objectTags': {
                'text': item.get('text', ''),
                'metadata': item.get('metadata', {}),
            },
        }

    @staticmethod
    def _identity_for_item(item: Dict[str, Any]) -> str:
        """Return a stable identity for one dataset row.

        This used to be ``uuid.uuid4()``, which minted a fresh identity for the
        same logical row on every scan — nothing downstream could dedup a
        re-emitted row or resume a partially-processed dataset.

        The identity is the row's ``dataset_id``, which
        ``DatasetLoader.to_questions`` guarantees is present and usable: the
        row's own id when it has an addressable one (``0`` and ``False``
        included), and a deterministic ``sha256-`` digest of the row otherwise.
        Using that same string here keeps the entry identity and the join key
        downstream consumers correlate on identical.

        The emitted URL keeps its ``{index}/`` prefix: a dataset may legally
        repeat a row verbatim, and those rows share a content digest, so the
        ordinal is what keeps their entries distinct for the engine's object
        identity.

        Args:
            item: A question dict as produced by ``DatasetLoader.to_questions``.

        Returns:
            A URL-safe identity string for this row.
        """
        metadata = item.get('metadata') or {}
        dataset_id = metadata.get('dataset_id') if isinstance(metadata, dict) else None
        if dataset_id is not None and dataset_id != '':
            return quote(str(dataset_id), safe='')

        # to_questions always supplies a usable dataset_id; this covers an entry
        # assembled by hand, so identity stays deterministic either way.
        payload = json.dumps(
            {'text': item.get('text', ''), 'metadata': metadata},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(payload.encode('utf-8')).hexdigest()
