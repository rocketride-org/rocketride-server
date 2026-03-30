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
from typing import TYPE_CHECKING, Any, Dict, List

from rocketlib import IGlobalBase, OPEN_MODE, debug, warning
from ai.common.config import Config

if TYPE_CHECKING:
    from .dataset_loader import DatasetLoader


class IGlobal(IGlobalBase):
    """Global lifecycle for the Cobalt Dataset node.

    Manages dataset loading during pipeline initialization and provides
    the loaded dataset items to IInstance for per-question emission.
    """

    _loader: 'DatasetLoader'
    _dataset: List[Dict[str, Any]]
    _questions: List[Dict[str, Any]]

    def validateConfig(self):
        """Validate dataset configuration at save-time.

        Checks that:
        - file_path exists when source_type is 'file'
        - sample_size is non-negative
        - file path does not contain traversal sequences
        """
        try:
            config = self._extractConfig()

            source_type = config.get('source_type', 'file')
            file_path = config.get('file_path', '')
            sample_size = int(config.get('sample_size', 0))

            if source_type == 'file':
                if not file_path:
                    warning('Cobalt Dataset Global: No file path provided for file source type.')
                    return

                if '..' in file_path.replace('\\', '/').split('/'):
                    warning(f'Cobalt Dataset Global: Path traversal detected in file path: {file_path}')
                    return

                normalized = os.path.normpath(file_path)
                if not os.path.isfile(normalized):
                    warning(f'Cobalt Dataset Global: File not found: {normalized}')
                    return

            if sample_size < 0:
                warning(f'Cobalt Dataset Global: sample_size must be >= 0, got {sample_size}')
                return

        except Exception as e:
            warning(f'Cobalt Dataset Global: Configuration validation error: {str(e)}')
            return

    def beginGlobal(self):
        """Initialize the DatasetLoader and load the dataset.

        In CONFIG mode (pipeline save) this is a no-op to avoid loading
        datasets during configuration saves.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        debug('Cobalt Dataset Global: Starting global initialization')

        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        debug(f'Cobalt Dataset Global: Loading requirements from {requirements}')
        depends(requirements)

        # Import after dependencies are installed
        from .dataset_loader import DatasetLoader

        # Get endpoint bag and config
        bag = self.IEndpoint.endpoint.bag
        config = self._extractConfig()
        debug(f'Cobalt Dataset Global: Config keys: {list(config.keys())}')

        # Create loader and load dataset
        self._loader = DatasetLoader(config, bag)

        try:
            items = self._loader.load()
            debug(f'Cobalt Dataset Global: Loaded {len(items)} raw items')
        except FileNotFoundError as e:
            warning(f'Cobalt Dataset Global: {str(e)}')
            items = []
        except ValueError as e:
            warning(f'Cobalt Dataset Global: {str(e)}')
            items = []
        except ImportError as e:
            warning(f'Cobalt Dataset Global: Failed to import cobalt library: {str(e)}')
            warning('Cobalt Dataset Global: Ensure cobalt-ai is installed. pip install cobalt-ai')
            items = []

        # Apply transforms
        self._dataset = self._loader.apply_transforms(items, config)
        debug(f'Cobalt Dataset Global: {len(self._dataset)} items after transforms')

        # Convert to question-compatible dicts
        self._questions = self._loader.to_questions(self._dataset)
        debug(f'Cobalt Dataset Global: {len(self._questions)} questions prepared')

    def _extractConfig(self) -> Dict[str, Any]:
        """Extract and validate node configuration.

        When Config.getNodeConfig returns a dict wrapped under a 'default'
        key (the engine's convention for nodes that expose a single config
        panel), this method unwraps it so callers always see a flat dict.
        Note: any non-default top-level keys in the raw config are discarded
        during unwrap; this is intentional because the engine only persists
        user-editable fields inside 'default'.

        Returns:
            Processed config dictionary.
        """
        current_conn_config = getattr(self.IEndpoint.endpoint, 'connConfig', self.glb.connConfig)
        config = Config.getNodeConfig(self.glb.logicalType, current_conn_config)

        # Unwrap 'default' envelope — the engine nests user-editable fields
        # under this key for single-panel nodes. Non-default keys (if any)
        # are engine metadata and are intentionally discarded here.
        if 'default' in config:
            config = config.get('default', {})

        return config

    def endGlobal(self):
        """Clean up resources."""
        debug('Cobalt Dataset Global: Starting global cleanup')
        self._loader = None
        self._dataset = None
        self._questions = None
        debug('Cobalt Dataset Global: Cleanup completed')
