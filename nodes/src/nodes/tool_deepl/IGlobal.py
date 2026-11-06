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


from rocketlib import IGlobalBase, error

VALID_FORMALITIES = {'default', 'more', 'less', 'prefer_more', 'prefer_less'}
VALID_MODEL_TYPES = {'latency_optimized', 'quality_optimized', 'prefer_quality_optimized'}


class IGlobal(IGlobalBase):
    """Global state for tool_deepl."""

    apikey: str = ''
    target_lang: str = 'EN-US'
    formality: str = 'default'
    model_type: str = ''

    def beginGlobal(self) -> None:
        config = self.config

        # The key reaches the node through its config (a ${ROCKETRIDE_DEEPL_APIKEY}
        # reference resolved per call); there is no process-env fallback
        apikey = str(config.apikey or '').strip()

        if not apikey:
            error('tool_deepl: apikey is required - set it in the node config (a ${ROCKETRIDE_DEEPL_APIKEY} reference)')
            raise ValueError('tool_deepl: apikey is required')

        self.apikey = apikey

        # The schema default is EN-US; a field cleared in the UI stores '' and
        # falls back to it here, because the instance treats target_lang as required.
        self.target_lang = config.targetLang.strip() or 'EN-US'

        # formality / model_type are stored as the raw (stripped) config value,
        # NOT coerced to a default: the resolution rule is "argument wins, config
        # is the fallback, and an empty config means the parameter is omitted."
        # Coercing an empty config back to a value would defeat a user who
        # cleared the field in the UI. _resolve_enum on the instance side does
        # the validity check at request time.
        self.formality = config.formality.strip()
        self.model_type = config.modelType.strip()

    def endGlobal(self) -> None:
        self.apikey = ''
