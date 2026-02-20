# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

from .IGlobal import IGlobal
from .IInstance import IInstance


def getEmbedding():
    """
    Return the Embedding class from the embedding module.

    This function performs a lazy import of the Embedding class to avoid
    import overhead or circular dependencies when this module is loaded.

    Returns:
        class: The Embedding class used for creating image embeddings.
    """
    from .embedding import Embedding

    return Embedding


# Explicitly define the public API of this module.
# This helps tools and users know which names are intended for import.
__all__ = [
    'IInstance',  # Interface/class for instances handling document processing
    'IGlobal',  # Interface/class for global-level operations and resources
    'getEmbedding',  # Function to retrieve the Embedding class
]
