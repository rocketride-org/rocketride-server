# =============================================================================
# RocketRide Engine
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

"""
DeepL tool node - global (shared) state.

Reads the DeepL API key and default translation configuration from the node
config. Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning

# Pipeline env vars must be ROCKETRIDE_-prefixed (only those are substituted,
# and the node-test framework maps ROCKETRIDE_<PROVIDER>_<ATTR> -> config).
DEEPL_API_KEY_ENV = 'ROCKETRIDE_DEEPL_KEY'

VALID_FORMALITIES = {'default', 'more', 'less', 'prefer_more', 'prefer_less'}
VALID_MODEL_TYPES = {'latency_optimized', 'quality_optimized', 'prefer_quality_optimized'}


class IGlobal(IGlobalBase):
    """Global state for tool_deepl."""

    apikey: str = ''
    target_lang: str = 'EN-US'
    formality: str = 'default'
    model_type: str = ''

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Strip the config value FIRST so a whitespace-only field falls through
        # to the env var rather than shadowing it (config still wins for any
        # real value).
        apikey = str(cfg.get('apikey') or '').strip() or os.environ.get(DEEPL_API_KEY_ENV, '').strip()

        if not apikey:
            error(f'tool_deepl: apikey is required — set it in node config or the {DEEPL_API_KEY_ENV} env var')
            raise ValueError('tool_deepl: apikey is required')

        self.apikey = apikey

        target_lang = str(cfg.get('targetLang') or 'EN-US').strip()
        self.target_lang = target_lang or 'EN-US'

        # formality / model_type are stored as the raw (stripped) config value,
        # NOT coerced to a default: the resolution rule is "argument wins, config
        # is the fallback, and an empty config means the parameter is omitted."
        # Coercing an empty config back to a value would defeat a user who
        # cleared the field in the UI. _resolve_enum on the instance side does
        # the validity check at request time.
        self.formality = str(cfg.get('formality') or '').strip()
        self.model_type = str(cfg.get('modelType') or '').strip()

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str(cfg.get('apikey') or '').strip() or os.environ.get(DEEPL_API_KEY_ENV, '').strip()
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.apikey = ''
