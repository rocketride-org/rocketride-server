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

import math
from typing import List

from rocketlib import Entry, IInstanceBase
from ai.common.decision import DecisionRecorder
from ai.common.schema import Doc, DocMetadata
from .IGlobal import IGlobal

SEVERITY_LEVELS = ('normal', 'warning', 'critical')
QUESTIONS = {
    'is_anomalous': {'kind': 'yes_no', 'values': ['yes', 'no']},
    'severity': {'kind': 'rubric', 'levels': list(SEVERITY_LEVELS), 'values': list(SEVERITY_LEVELS)},
    'score': {'kind': 'number'},
}


def _has_usable_metric(metadata: dict, metric: str) -> bool:
    """Return True when the metric is present in the metadata and converts to a finite float."""
    try:
        return math.isfinite(float(metadata.get(metric)))
    except (ValueError, TypeError):
        return False


def _answers(result: dict) -> dict:
    severity = result['severity']
    return {
        'is_anomalous': {'answer': 'yes' if result['is_anomalous'] else 'no'},
        'severity': {'answer': severity, 'index': SEVERITY_LEVELS.index(severity)},
        'score': {'answer': float(result['score'])},
    }


class IInstance(IInstanceBase):
    """
    Instance handler for Anomaly Detector node.

    Processes individual documents and text, checking numeric values
    for anomalies and annotating results with severity classifications.
    """

    IGlobal: IGlobal

    def open(self, obj: Entry):
        """Initialize instance for a new object: a fresh decision recorder."""
        self.decisions = DecisionRecorder(self, QUESTIONS)

    def writeText(self, text: str):
        """
        Process text and check for anomalous numeric values.

        Attempts to parse numeric values from text, runs anomaly detection,
        and annotates the output with detection results.
        """
        # Both branches forward on this lane, so both must suppress the engine's own
        # forward. preventDefault() raises, so it goes after the forward it guards.
        if self.IGlobal.detector is None:
            self.instance.writeText(text)
            return self.preventDefault()
        result = self.IGlobal.detector.evaluate_text(text)
        self.instance.writeText(result)
        return self.preventDefault()

    def writeDocuments(self, documents: List[Doc]):
        """
        Process documents and check metric fields for anomalies.

        Reads the configured metric field from each document's metadata,
        runs anomaly detection, and adds results to document metadata.
        """
        # As in writeText, or downstream also receives the un-enriched originals.
        if self.IGlobal.detector is None:
            self.instance.writeDocuments(documents)
            return self.preventDefault()

        enriched_docs = []

        for doc in documents:
            enriched_doc = doc.model_copy(deep=True)
            if enriched_doc.metadata is None:
                enriched_doc.metadata = DocMetadata(self, chunkId=0)
                self.decisions.record_status('documents', 'unsupported', doc=enriched_doc)
                enriched_docs.append(enriched_doc)
                continue

            metadata_dict = enriched_doc.metadata.model_dump()
            result = self.IGlobal.detector.evaluate_document(metadata_dict)

            enriched_doc.metadata.anomaly_score = result['score']
            enriched_doc.metadata.anomaly_severity = result['severity']
            enriched_doc.metadata.anomaly_is_anomalous = result['is_anomalous']
            if result.get('details'):
                enriched_doc.metadata.anomaly_details = result['details']
            if _has_usable_metric(metadata_dict, self.IGlobal.detector.metric):
                self.decisions.record_document(enriched_doc, _answers(result))
            else:
                # Not scored (no metric, or not a number): never a confident 'no'.
                self.decisions.record_status('documents', 'unsupported', doc=enriched_doc)

            enriched_docs.append(enriched_doc)

        self.instance.writeDocuments(enriched_docs)
        return self.preventDefault()

    def closing(self):
        """Finalize any pending operations before close."""
        pass

    def close(self):
        """Clean up instance state."""
        pass
