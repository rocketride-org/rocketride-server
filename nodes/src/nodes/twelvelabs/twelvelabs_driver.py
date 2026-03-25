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

import uuid
from typing import List
import time

from rocketlib import debug


def process_video(api_key: str, video_path: str, instructions: List[str]) -> str:
    """
    Upload a video to TwelveLabs, wait for indexing, generate text, and return it.

    Creates a temporary index, uploads the video, waits for the task to complete,
    generates text using the provided instructions, then deletes the index.

    Args:
        api_key:      TwelveLabs API key.
        video_path:   Path to the local video file to analyze.
        instructions: List of instruction strings joined into the generation prompt.

    Returns:
        Generated text from TwelveLabs.
    """
    from twelvelabs import TwelveLabs
    from twelvelabs.indexes import IndexesCreateRequestModelsItem

    prompt = '\n'.join(instructions) if instructions else 'Describe this video.'

    client = TwelveLabs(api_key=api_key)

    index_name = f'rocketride-{uuid.uuid4().hex[:8]}'
    debug(f'TwelveLabs: creating index "{index_name}"')

    index = None

    try:
        index = client.indexes.create(
            index_name=index_name,
            models=[
                IndexesCreateRequestModelsItem(
                    model_name='pegasus1.2',
                    model_options=['visual', 'audio'],
                ),
            ],
        )

        debug(f'TwelveLabs: uploading video "{video_path}"')
        with open(video_path, 'rb') as video_file:
            task = client.tasks.create(index_id=index.id, video_file=video_file)
        debug(f'TwelveLabs: started task {task.id}')

        MAX_WAIT_TIME = 60 * 15  # 15 minutes
        waited = 0
        while True:
            task = client.tasks.retrieve(task.id)
            debug(f'TwelveLabs: task status={task.status}')
            if task.status == 'ready':
                break
            if task.status == 'failed':
                raise RuntimeError('TwelveLabs task failed')

            # check if we waited too long
            if waited >= MAX_WAIT_TIME:
                raise RuntimeError('TwelveLabs task timed out')
            time.sleep(5)
            waited += 5

        debug(f'TwelveLabs: generating text, video_id={task.video_id}')
        result = client.analyze(video_id=task.video_id, prompt=prompt)
        generated_text = result.data or ''
        debug(f'TwelveLabs: generated text length={len(generated_text)}')
        return generated_text

    except Exception as e:
        debug(f'TwelveLabs: Error: {e}')
        raise
    finally:
        if index:
            try:
                debug(f'TwelveLabs: deleting index "{index.id}"')
                client.indexes.delete(index.id)
            except Exception as e:
                debug(f'TwelveLabs: failed to delete index: {e}')
