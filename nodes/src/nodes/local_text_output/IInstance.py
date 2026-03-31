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
from rocketlib import IInstanceBase, Entry, warning
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Instance processor for Local Text Output node.

    This class handles the processing of individual source objects, collecting text content
    and writing it to local text files while maintaining directory structure.
    """

    IGlobal: IGlobal
    current_object: Entry = None
    target_object_text: str = None

    def beginInstance(self) -> None:
        pass

    def endInstance(self) -> None:
        pass

    def writeText(self, text: str):
        """
        Accumulate text content for the current object.

        Args:
            text: Text content to append to the current object's text buffer.
        """
        if self.current_object is None:
            return
        if self.target_object_text is None:
            self.target_object_text = ''
        self.target_object_text += text

    def open(self, object: Entry):
        """
        Open a new source object for processing.

        Args:
            object: The source Entry object to process.
        """
        self.current_object = object
        self.target_object_text = ''

    def close(self):
        """
        Close the current object and write accumulated text to file.

        This method processes the accumulated text content and writes it to a local text file,
        maintaining the directory structure and converting the file extension to .txt.
        """
        if not self.current_object.objectFailed:
            try:
                output_path = self.IGlobal.output_path

                # Check if output_path is valid
                if not output_path:
                    raise Exception('Output path is not set')

                # Get the absolute path from the source object
                abs_path = self.current_object.path
                exclude = self.IGlobal.exclude

                # Determine if the absolute path should be used or if we need to exclude a path
                relative_path = ''
                if exclude == 'N/A':
                    relative_path = abs_path
                else:
                    if abs_path.startswith(exclude):
                        relative_path = abs_path.replace(exclude, '')
                    else:
                        warning(f'The path {abs_path} does not start with {exclude}')
                        return

                # Remove the file extension and add .txt
                # e.g. Hackathon/folder1/gradient_terms_of_use.txt
                name, _ = os.path.splitext(relative_path)
                file = f'{name}.txt'

                # Create the full target path by joining with output directory
                # e.g. /Users/username/Desktop/Hackathon/folder1/gradient_terms_of_use.txt
                resolved_output = os.path.realpath(output_path)
                candidate_path = os.path.realpath(os.path.join(resolved_output, file.lstrip('/\\')))
                try:
                    is_within_output = os.path.commonpath([resolved_output, candidate_path]) == resolved_output
                except ValueError:
                    is_within_output = False
                if not is_within_output:
                    raise ValueError(f'Path traversal detected: {file} resolves outside output directory')
                file_path = candidate_path

                # Create all necessary subdirectories
                target_dir = os.path.dirname(file_path)
                try:
                    os.makedirs(target_dir, exist_ok=True)
                except Exception as dir_error:
                    warning(f'Failed to create directory structure {target_dir}: {dir_error}')
                    return

                # Write text data to file (only if we have text)
                if self.target_object_text:
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.write(self.target_object_text)

            except Exception as e:
                warning(f'Exception in close: {e}')
                return

        # Reset current object context
        self.current_object = None
        self.target_object_text = None
