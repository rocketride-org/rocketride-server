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

from rocketlib import IGlobalBase

from ai.common.utils import LoaderCache

from .embedding import Embedding

#: The image models every control of this engine shares, keyed by model name.
_MODELS = LoaderCache()


class IGlobal(IGlobalBase):
    """
    IGlobal is a subclass of IGlobalBase that manages global lifecycle events for an AI node, such as initialization and cleanup of resources.

    It handles the setup of the AI embedding model at the start of the node's
    global lifecycle and ensures proper cleanup when the lifecycle ends.
    """

    embedding: Embedding | None = None

    def beginGlobal(self):
        """
        Load the image embedding model named by the resolved config.

        The selected profile pins the Hugging Face model (or, on the custom
        profile, the user typed it), so ``self.config.model`` is always set.

        Note:
            Nothing here loads or installs torch. ai.common.models proxies to the
            model server when --modelserver is set; on the local path its loader
            installs the model stack (transformers, torch) itself. So the node
            declares no requirements of its own: a requirements.txt naming
            accelerate made every cloud run download a CUDA torch it never used.
        """
        model = self.config.model
        self.embedding = _MODELS.get(model, lambda: Embedding(model))

    def endGlobal(self):
        """
        Clean up resources and references when the global lifecycle ends.

        Drops this control's reference; the model stays in the module-scope
        loader cache for the next control that names it.
        """
        self.embedding = None
