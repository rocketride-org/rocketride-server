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

from rocketlib import Entry, IInstanceBase
from .IGlobal import IGlobal
from .anonymize import clean_entity_types


class IInstance(IInstanceBase):
    IGlobal: IGlobal  # Reference to a global context providing recognizer functionality

    def _redaction(self) -> Dict[str, Any]:
        """
        This call's redaction: the style ('mask' or 'token') and the mask character.

        Returns:
            The keyword arguments ``process`` and ``handleClassifications`` take.
        """
        settings = self.settings
        return {'redaction_style': settings.redactionStyle, 'anonymize_char': settings.anonymizeChar}

    #
    # Current object context properties
    #
    target_object_text: str = ''
    has_classifications: bool = False

    def open(self, object: Entry):
        self.target_object_text = ''
        self.has_classifications = False

    def writeText(self, text: str):
        self.target_object_text = self.target_object_text + text
        # Prevent further writeText, Anonymization would resume the writeText lane at closing
        self.preventDefault()

    def writeClassifications(self, classifications: dict, classificationPolicy: dict, classificationRules: dict):
        self.has_classifications = True
        self.target_object_text = self.IGlobal.recognizer.handleClassifications(
            classifications, self.target_object_text, classificationPolicy, classificationRules, **self._redaction()
        )

    def closing(self):
        if not self.has_classifications:
            # No classifications received - anonymize with the call's entity types:
            # clean_entity_types drops blank entries and falls back to the common
            # defaults when the result is empty, so detection is never silently disabled
            self.target_object_text = self.IGlobal.recognizer.process(
                self.target_object_text, clean_entity_types(self.settings.entityTypes), **self._redaction()
            )

        # Resume the writeText lane
        self.instance.writeText(self.target_object_text)

    def close(self):
        """Call from engLib, process object startup."""
        # Reset current object context
        self.current_object = None
        self.target_object_path = None
        self.target_object_text = None
