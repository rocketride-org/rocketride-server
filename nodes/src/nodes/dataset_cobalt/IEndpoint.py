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
import uuid
from typing import Any, Callable, Dict, List

from ai.common.config import Config
from rocketlib import IEndpointBase, debug, monitorCompleted, monitorStatus, warning


class IEndpoint(IEndpointBase):
    """Source endpoint for emitting Cobalt dataset rows into a pipeline."""

    target: IEndpointBase | None = None

    def scanObjects(self, _path: str, _scanCallback: Callable[[Dict[str, Any]], None]):
        """Load the configured dataset and emit each row as a Question."""
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
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        debug(f'Cobalt Dataset Endpoint: Loading requirements from {requirements}')
        depends(requirements)

        from .dataset_loader import DatasetLoader

        config = self._extractConfig()
        debug(f'Cobalt Dataset Endpoint: Config keys: {list(config.keys())}')

        loader = DatasetLoader(config, self.endpoint.bag)
        try:
            items = loader.load()
            dataset = loader.apply_transforms(items, config)
            questions = loader.to_questions(dataset)
            debug(f'Cobalt Dataset Endpoint: Prepared {len(questions)} questions')
            return questions
        except FileNotFoundError as exc:
            warning(f'Cobalt Dataset Endpoint: {exc!s}')
        except ValueError as exc:
            warning(f'Cobalt Dataset Endpoint: {exc!s}')
        except ImportError as exc:
            warning(f'Cobalt Dataset Endpoint: Failed to import cobalt library: {exc!s}')
            warning('Cobalt Dataset Endpoint: Ensure basalt-ai-cobalt is installed. pip install basalt-ai-cobalt')
        except Exception as exc:  # noqa: BLE001 - source endpoint should report and complete empty
            warning(f'Cobalt Dataset Endpoint: Failed to prepare dataset: {exc!s}')

        return []

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
        return any(key in config for key in ('profile', 'source_type', 'items', 'file_path', 'dataset.source_type', 'dataset.items', 'inline', 'file'))

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
        text = item.get('text', '') or f'Cobalt dataset item {index}'

        return {
            'url': f'dataset_cobalt://{index}/{uuid.uuid4()}',
            'name': text[:200],
            'isContainer': False,
            'size': len(text.encode('utf-8')),
            'objectTags': {
                'text': item.get('text', ''),
                'metadata': item.get('metadata', {}),
            },
        }
