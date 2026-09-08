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

from rocketlib import IGlobalBase, warning
from ai.common.config import Config

from .validate import SEVERITY_RANK, default_config


class IGlobal(IGlobalBase):
    """Global lifecycle: read and normalise the node configuration once per run."""

    def beginGlobal(self):
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig) or {}

        config = default_config()

        # String field names normalise empty/whitespace back to their default.
        for key in ('amount_field', 'currency_field', 'metric_field', 'category_field'):
            config[key] = str(raw.get(key) or config[key]).strip() or config[key]

        # Severity enums accept only off/warning/error; anything else warns and
        # falls back so the node keeps validating rather than failing the run.
        for key in ('sign', 'require_provenance'):
            value = raw.get(key)
            if value is None:
                continue
            # ``value in SEVERITY_RANK`` would raise TypeError on an unhashable
            # value (a JSON list/object supplied via a .pipe), so gate on str.
            if isinstance(value, str) and value in SEVERITY_RANK and value != 'ok':
                config[key] = value
            else:
                warning(f"schema_validate: '{key}' must be off/warning/error; using default '{config[key]}'.")

        # The metric→category map must be a dict of keyword lists; a malformed
        # value warns and keeps the built-in default map rather than crashing.
        cat_map = raw.get('category_metric_map')
        if cat_map is not None:
            if isinstance(cat_map, dict) and all(isinstance(v, list) for v in cat_map.values()):
                config['category_metric_map'] = {
                    str(k): [str(kw).strip().lower() for kw in v] for k, v in cat_map.items()
                }
            else:
                warning('schema_validate: category_metric_map must be an object of keyword lists; using default map.')

        self.config = config

    def endGlobal(self):
        self.config = None
