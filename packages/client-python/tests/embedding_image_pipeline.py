# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Minimal pipeline for E2E testing of the embedding_image node.

Use with or without --modelserver:
  - Without: model runs locally in the server process.
  - With: model runs on the model server (proxy).

Usage:
    from embedding_image_pipeline import get_embedding_image_pipeline

    pipeline = get_embedding_image_pipeline()
    result = await client.use(pipeline=pipeline, token='E2E-EMBEDDING-IMAGE')
    # Send a document with page_content = base64 image (e.g. data:image/png;base64,...)
"""

from typing import Dict, Any


def get_embedding_image_pipeline() -> Dict[str, Any]:
    """
    Minimal pipeline: webhook -> embedding_image -> response.

    Validates embedding_image node E2E (local or via model server).
    Client should send JSON body with documents containing page_content as base64 image.
    """
    return {
        "components": [
            {
                "id": "webhook_1",
                "provider": "webhook",
                "config": {"hideForm": True, "mode": "Source", "type": "webhook"},
            },
            {
                "id": "embedding_image_1",
                "provider": "embedding_image",
                "config": {"profile": "openai-patch16"},
                "input": [{"lane": "documents", "from": "webhook_1"}],
            },
            {
                "id": "response_1",
                "provider": "response",
                "config": {"lanes": []},
                "input": [{"lane": "documents", "from": "embedding_image_1"}],
            },
        ],
        "source": "webhook_1",
        "project_id": "e612b741-748c-4b35-a8b7-186797a8ea42",
    }
