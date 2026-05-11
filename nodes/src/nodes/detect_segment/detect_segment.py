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

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, List
from ai.common.models.detection import Sam3Model
from ai.common.config import Config


class Detector:
    """
    Wraps Sam3Model for the detect_segment node.

    Reads model, threshold, and prompt from node config. Exposes
    detect(image) for use by IInstance handlers.

    Attributes:
        model_name (str): HuggingFace model identifier.
        threshold (float): Minimum confidence score for detections.
        prompt (str): Static text prompt describing what to detect.
        model: Sam3Model instance (local or server-proxied).
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Load model and configure from provider settings."""
        config = Config.getNodeConfig(provider, connConfig)

        self.model_name = config.get('model', 'facebook/sam3.1')
        self.threshold = float(config.get('threshold', 0.5))
        self.prompt = config.get('prompt', '')

        self.model = Sam3Model.from_pretrained(
            self.model_name,
            threshold=self.threshold,
        )

    def detect(self, image: Any) -> List[Dict[str, Any]]:
        """
        Run object detection using the static config prompt.

        Args:
            image: PIL Image object (RGB).

        Returns:
            List of {label, score, box: {x1,y1,x2,y2}, centroid: {x,y}} dicts.
        """
        if image is None:
            raise ValueError('Image must not be None')
        return self.model.detect(image, prompt=self.prompt)
