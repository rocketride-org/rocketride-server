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
Landing.ai Extract save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``: the API key is required, region an enum), and the
semantic checks are the uploaded schema (it must decode to a JSON object) and
a cheap read-only ADE call that proves the key works. The ADE client is
imported inside the probe so this module stays import-light.
"""

from rocketlib import IValidatorBase, warning

from ..landing_ai_base import ensure_dependencies, load_schema_from_data_url, validate_credentials


_PREFIX = 'Landing.ai Extract: '


def _prefixed(message: object) -> str:
    """Return ``message`` under the node prefix, added only when it is not already there."""
    text = str(message)
    return text if text.startswith(_PREFIX) else f'{_PREFIX}{text}'


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the upload and credential checks (warn-only)."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, the upload and the ADE key.

        Args:
            syntaxOnly (bool): True checks the shape only; no network.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        schema_file = config.get('schema_file') or ''
        if not schema_file:
            warning(_prefixed('no extraction schema uploaded'))
        else:
            try:
                load_schema_from_data_url(schema_file)
            except ValueError as e:
                warning(_prefixed(e))
        try:
            ensure_dependencies()
            err = validate_credentials(config)
            if err:
                warning(_prefixed(err))
        except Exception as e:  # noqa: BLE001 - warn-only; never block canvas editing
            warning(_prefixed(e))
