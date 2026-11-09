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
Landing.ai Parse save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``: the API key is required, model and region are
enums), and the semantic check is a cheap read-only ADE call that proves the
key works. The ADE client is imported inside the probe so this module stays
import-light.
"""

from rocketlib import IValidatorBase, warning

from ..landing_ai_base import ensure_dependencies, validate_credentials


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the credential probe (warn-only)."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, probe the ADE key.

        Args:
            syntaxOnly (bool): True checks the shape only; no network.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        try:
            ensure_dependencies()
            err = validate_credentials(config)
            if err:
                warning(f'Landing.ai Parse: {err}')
        except Exception as e:  # noqa: BLE001 - warn-only; never block canvas editing
            warning(f'Landing.ai Parse: {e}')
