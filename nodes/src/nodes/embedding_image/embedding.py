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
from depends import depends  # type: ignore

# Load the requirements from a requirements.txt file located in the same directory
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

import numpy as np
from typing import Dict, Any, List
from ai.common.models.vision import CLIPModel, ViTModel
from ai.common.config import Config
from ai.common.image.image import Image


class Embedding:
    """
    Embedding class that wraps a Hugging Face image model (CLIP or ViT) for generating image embeddings.

       This class initializes a pre-trained image model based on node-specific configuration,
       and provides a method to create normalized embeddings from Pillow Image objects.

       The node is completely agnostic to whether the model runs locally or on a remote server.
       Both paths use the same inference logic and return identical results.

       It supports both:
       - CLIP models (e.g., 'openai/clip-vit-base-patch16')
       - ViT models (e.g., 'google/vit-base-patch16-224')

       Attributes:
           model_name (str): The Hugging Face model identifier.
           model: The model proxy (handles local/remote transparently).
           model_type (str): Type of model loaded ('clip' or 'vit').
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Embedding instance.

        Loads node-specific configuration to determine which image model to use (CLIP or ViT),
        and sets up the model with appropriate output specification.

        The model proxy automatically determines whether to run locally or on the model server.

        Args:
            provider (str): The logical type or provider identifier for the node.
            connConfig (Dict[str, Any]): node-specific configuration dictionary.
            bag (Dict[str, Any]): Additional data bag, not used here but available for extension.
        """
        # Retrieve configuration for the node using a global config helper
        config = Config.getNodeConfig(provider, connConfig)

        # Fetch the model name from the config or use the default CLIP model
        self.model_name = config.get('model', 'openai/clip-vit-base-patch16')

        if 'clip' in self.model_name.lower():
            # CLIP model - extract and normalize image features
            self.model = CLIPModel.from_pretrained(
                self.model_name,
                output_spec=[('image_features', None, None, None, True)],  # Get image_features, normalized
            )
            self.model_type = 'clip'
        else:
            # ViT model - extract CLS token and normalize
            self.model = ViTModel.from_pretrained(
                self.model_name,
                output_spec=[('last_hidden_state', None, 0, None, True)],  # Get CLS token, normalized
            )
            self.model_type = 'vit'

    def create_image_embedding(self, image: Image) -> List[float]:
        """
        Create a normalized embedding vector for a given image.

        This method is completely agnostic to local vs. remote execution.
        The model proxy handles routing transparently, and both paths use
        the same inference logic with output_spec extraction.

        Args:
            image (Image): A Pillow Image object to embed.

        Returns:
            List[float]: A normalized vector representing the image embedding.

        Raises:
            ValueError: If the input image is None or invalid.
        """
        # Defensive check to ensure image decoding was successful
        if image is None:
            raise ValueError('Failed to decode image data. Ensure the image is in a supported format.')

        # Get embedding (works identically for local and remote!)
        if self.model_type == 'clip':
            embedding = self.model.get_image_features(image)
        else:  # ViT
            embedding = self.model(image)

        if isinstance(embedding, np.ndarray):
            return embedding.squeeze().tolist()
        elif isinstance(embedding, list):
            return embedding
        else:
            # Assume it's array-like
            return np.array(embedding).squeeze().tolist()
