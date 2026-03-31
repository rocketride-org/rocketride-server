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

from typing import List
from rocketlib import Entry, IInstanceBase
from ai.common.schema import Doc
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Instance handler for Anomaly Detector node.

    Processes individual documents and text, checking numeric values
    for anomalies and annotating results with severity classifications.
    """

    IGlobal: IGlobal

    def open(self, obj: Entry):
        """Initialize instance for a new object."""
        pass

    def writeText(self, text: str):
        """
        Process text and check for anomalous numeric values.

        Attempts to parse numeric values from text, runs anomaly detection,
        and annotates the output with detection results.
        """
        if self.IGlobal.detector is None:
            self.instance.writeText(text)
            return
        result = self.IGlobal.detector.evaluate_text(text)
        self.instance.writeText(result)

    def writeDocuments(self, documents: List[Doc]):
        """
        Process documents and check metric fields for anomalies.

        Reads the configured metric field from each document's metadata,
        runs anomaly detection, and adds results to document metadata.
        """
        if self.IGlobal.detector is None:
            self.instance.writeDocuments(documents)
            return

        enriched_docs = []

        for doc in documents:
            enriched_doc = doc.model_copy()
            if enriched_doc.metadata is None:
                enriched_doc.metadata = {}

            result = self.IGlobal.detector.evaluate_document(enriched_doc.metadata)

            enriched_doc.metadata['anomaly_score'] = result['score']
            enriched_doc.metadata['anomaly_severity'] = result['severity']
            enriched_doc.metadata['anomaly_is_anomalous'] = result['is_anomalous']
            if result.get('details'):
                enriched_doc.metadata['anomaly_details'] = result['details']

            enriched_docs.append(enriched_doc)

        self.instance.writeDocuments(enriched_docs)

    def closing(self):
        """Finalize any pending operations before close."""
        pass

    def close(self):
        """Clean up instance state."""
        pass
