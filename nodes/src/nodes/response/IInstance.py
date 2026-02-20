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

import os
from rocketlib import IInstanceBase
from ai.common.schema import Doc, Question, Answer
from ai.common.image import ImageProcessor
from rocketlib import AVI_ACTION, Entry, debug
from typing import List
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    text: str = ''
    image = bytearray()

    def _getkey(self, type: str):
        # Allow the key to be overriden by
        #   connConfig: {
        #       laneName: "defdoc"
        #   }
        #   connConfig: {
        #       lanes: {
        #           laneId: "documents"
        #           laneName: "defdoc"
        #       }
        #   }

        # If we are using the new stye:
        if self.IGlobal.laneName is not None:
            # Grab the key name
            key = self.IGlobal.laneName
        elif self.IGlobal.lanes:
            # If we are using the old style, grab the key
            key = self.IGlobal.lanes.get(type, type)
        else:
            key = type

        # Add the type so we can track it result_types
        if 'result_types' not in self.instance.currentObject.response:
            self.instance.currentObject.response['result_types'] = {}
        self.instance.currentObject.response['result_types'][key] = type

        # Return the key
        return key

    def open(self, object: Entry):
        """
        Initialize the instance for a new object.

        Resets chunk and table IDs to start fresh for this object's processing.

        Args:
            object (Entry): The object to initialize processing for.
        """
        self.text = ''  # Reset the text buffer
        self.image = bytearray()

    def close(self):
        """
        Finalize the instance for the current object.

        This method is called when processing of the current object is complete.
        """

        def deep_merge_dicts(src: dict, dest: dict):
            for key, value in src.items():
                if isinstance(value, dict) and isinstance(dest.get(key), dict):
                    deep_merge_dicts(value, dest[key])
                else:
                    # Manually copy dict or list to avoid shared references
                    if isinstance(value, dict):
                        dest[key] = deep_merge_dicts(value, {})
                    elif isinstance(value, list):
                        dest[key] = [deep_merge_dicts(item, {}) if isinstance(item, dict) else item for item in value]
                    else:
                        dest[key] = value
            return dest

        if self.text:
            # Get the key to write to
            key = self._getkey('text')

            # If it isn't there, create it
            if key not in self.instance.currentObject.response:
                self.instance.currentObject.response[key] = []

            # Add the text
            self.instance.currentObject.response[key].append(self.text)

        # Copy over the metadata info
        if self.instance.currentObject.hasMetadata:
            # Create the dict we will return
            metadata = {}

            # Copy over the keys
            for k, v in self.instance.currentObject.metadata.items():
                if 'tika' in k.lower():
                    continue
                metadata[k] = v

            # Set it
            self.instance.currentObject.response['metadata'] = metadata

        # Copy over the name
        if self.instance.currentObject.hasName:
            self.instance.currentObject.response['name'] = self.instance.currentObject.name

        # Copy over the path
        if self.instance.currentObject.hasPath:
            # Get the object path
            path = self.instance.currentObject.path

            # Strip the name
            directory = os.path.dirname(path)

            # Save it
            self.instance.currentObject.response['path'] = directory

    def writeText(self, text: str):
        # Save it out so we can write it into the text array
        self.text += text + '\n\n'

    def writeTable(self, table: str):
        # Get the key to write to (official lane name is "table")
        key = self._getkey('table')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the table
        self.instance.currentObject.response[key].append(table)

    def writeDocuments(self, documents: List[Doc]):
        # Get the key to write to
        key = self._getkey('documents')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the documents
        for document in documents:
            self.instance.currentObject.response[key].append(document.toDict())

    def writeQuestions(self, questions: Question):
        # Get the key to write to
        key = self._getkey('questions')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the documents
        self.instance.currentObject.response[key].append(questions.model_dump())

    def writeAnswers(self, answer: Answer):
        # Get the key to write to
        key = self._getkey('answers')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the documents
        if answer.isJson():
            self.instance.currentObject.response[key].append(answer.getJson())
        else:
            self.instance.currentObject.response[key].append(answer.getText())

    def writeAudio(self, aviAction: int, mimeType: str, data: bytes):
        # Get the key to write to
        key = self._getkey('audio')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Create the tracking info
        info = {'url': self.instance.currentObject.url, 'aviAction': str(aviAction), 'mimeType': mimeType, 'size': len(data)}

        # Add the documents
        self.instance.currentObject.response[key].append(info)

    def writeVideo(self, aviAction: int, mimeType: str, data: bytes):
        # Get the key to write to
        key = self._getkey('video')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Create the tracking info
        info = {'url': self.instance.currentObject.url, 'aviAction': str(aviAction), 'mimeType': mimeType, 'size': len(data)}

        # Add the documents
        self.instance.currentObject.response[key].append(info)

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        # Handle AVI_BEGIN action
        if action == AVI_ACTION.BEGIN:
            self.image = bytearray()

        # Handle AVI_WRITE action (appending chunks of the image)
        elif action == AVI_ACTION.WRITE:
            self.image += buffer  # Append the chunk to the existing image data

        # Handle AVI_END action (finalizing the image processing)
        elif action == AVI_ACTION.END:
            # Get the key to write to
            key = self._getkey('image')

            # If it isn't there, create it
            if key not in self.instance.currentObject.response:
                self.instance.currentObject.response[key] = []

            # Load the image
            image = ImageProcessor.load_image_from_bytes(self.image)
            if image is None:
                debug('Invalid image data provided')

            # Convert to base64
            image_str = ImageProcessor.get_base64(image)

            # Release the image
            self.image = bytearray()

            # Add the image
            self.instance.currentObject.response[key].append({'mime_type': mimeType, 'image': image_str})
