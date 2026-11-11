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

from typing import Any, Dict

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global lifecycle: read the resolved configuration once per run and normalise it for the checks."""

    # The validation settings the instances hand to validate_payload, built in beginGlobal
    validation: Dict[str, Any] = {}

    def beginGlobal(self):
        """Read the resolved config and lower-case the metric keywords, which match against lower-cased labels.

        The schema supplies the defaults, the field-name lengths and the
        severity enums. What it cannot express is checked here and fails the
        start: a field name that is blank once stripped, and a keyword map
        whose values are not lists.

        Raises:
            ValueError: A field name is blank, or a category's keywords are not a list.
        """
        config = self.config
        fields = {}
        for key in ('amount_field', 'currency_field', 'metric_field', 'category_field'):
            fields[key] = config[key].strip()
            if not fields[key]:
                raise ValueError(f'schema_validate: {key} must name a fact field; it is blank')
        for category, keywords in config.category_metric_map.items():
            if not isinstance(keywords, list):
                raise ValueError(f'schema_validate: category_metric_map[{category!r}] must be a list of keywords')
        self.validation = {
            **fields,
            'category_metric_map': {
                str(category): [str(keyword).strip().lower() for keyword in keywords]
                for category, keywords in config.category_metric_map.items()
            },
            'sign': config.sign,
            'require_provenance': config.require_provenance,
        }

    def endGlobal(self):
        self.validation = {}
