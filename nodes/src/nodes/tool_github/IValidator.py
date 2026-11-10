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
GitHub tool node - save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic checks are the node's own config
readers (the PEM decodes, ``defaultRepo`` is ``owner/repo``, every
``credentialMap`` row parses), so a bad row is reported while the user is still
editing the node, with the same message the pipeline would fail with at start.
The readers import the node's HTTP and JWT clients, which CONFIG mode does not
install, so they are imported inside the check and a missing requirement skips
it with a note instead of failing the save.
"""

from rocketlib import IValidatorBase, warning


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the auth and options readers."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, read auth and options.

        Args:
            syntaxOnly (bool): True checks the shape only; no credential parsing.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return

        try:
            from . import node_config
        except ImportError:
            warning(
                'Credential check skipped: the GitHub node requirements are not installed yet. '
                'It runs once the node has started and installed them.'
            )
            return

        for read in (node_config.read_auth, node_config.read_options):
            try:
                read(config)
            except Exception as e:
                warning(str(e))
