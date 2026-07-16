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
Frame Grabber Pipeline Configuration for Testing.

Builds a pipeline that extracts frames from an uploaded video and returns them
on the ``image`` lane: ``webhook -> frame_grabber -> response_image``.

Used to exercise per-object node parameters: the client can pass
``parameters={'frame_grabber_1': {'interval': <seconds>}}`` to vary how many
frames the frame_grabber node extracts for a given object.

Usage:
    from grabber_pipeline import get_grabber_pipeline

    token = await client.use(pipeline=get_grabber_pipeline())
"""

from typing import Dict, Any


def get_grabber_pipeline(project_id: str = 'a7c3e8d1-4b2f-4e6a-9c5d-3f8b1e2a6d40') -> Dict[str, Any]:
    """
    Get the frame-grabber pipeline configuration.

    The frame_grabber node is configured with its default ``interval`` profile
    (5 seconds between frames). Per-object overrides addressed to
    ``frame_grabber_1`` take precedence at runtime.

    Args:
        project_id: Unique project identifier. Concurrent pipelines must use
            distinct project_ids to avoid server-side contention during startup.

    Returns:
        Frame-grabber pipeline configuration.
    """
    return {
        'components': [
            {
                'id': 'webhook_1',
                'provider': 'webhook',
                'name': 'My webhook',
                'description': 'A webhook to receive video data',
                'config': {
                    'hideForm': True,
                    'mode': 'Source',
                    'type': 'webhook',
                },
            },
            {
                'id': 'frame_grabber_1',
                'provider': 'frame_grabber',
                'config': {
                    'profile': 'interval',
                    'interval': {'duration': 0, 'interval': 5, 'start_time': 0},
                },
                'input': [{'lane': 'video', 'from': 'webhook_1'}],
            },
            {
                'id': 'response_image_1',
                'provider': 'response_image',
                'config': {'laneName': 'image'},
                'input': [{'lane': 'image', 'from': 'frame_grabber_1'}],
            },
        ],
        'source': 'webhook_1',
        'project_id': project_id,
    }
