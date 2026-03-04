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

from rocketlib import Entry, IInstanceBase
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal  # Reference to a global context providing recognizer functionality
    
    # Default PII labels for zero-shot NER when no classifications provided
    DEFAULT_PII_LABELS = [
        'person', 'name', 'email', 'phone number', 'address',
        'social security number', 'credit card number', 'date of birth',
        'organization', 'company', 'location', 'ip address',
        'bank account', 'passport number', 'driver license'
    ]
    
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
        self.target_object_text = self.IGlobal.recognizer.handleClassifications(classifications, self.target_object_text, classificationPolicy, classificationRules)

    def closing(self):
        if not self.has_classifications:
            # No classifications received - anonymize with default PII labels
            self.target_object_text = self.IGlobal.recognizer.process(self.target_object_text, self.DEFAULT_PII_LABELS)
        
        # Resume the writeText lane
        self.instance.writeText(self.target_object_text)

    def close(self):
        """Call from engLib, process object startup."""
        # Reset current object context
        self.current_object = None
        self.target_object_path = None
        self.target_object_text = None
