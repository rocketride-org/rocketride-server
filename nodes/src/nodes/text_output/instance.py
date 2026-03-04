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

import errno
from os.path import dirname
import smbclient
from smbprotocol.exceptions import SMBOSError

import engLib
from engLib import Entry

# import errors
from rocketlib import Ec


class Instance:
    """Instance connection that performs anonymization of the text of the objects."""

    ANONYMIZE_ALL_LENGTH = 3
    TRANFORM_KEY_TAG_NAME: str = None

    def beginInstance(self):
        """Call from engLib, Instance initialization."""
        if not self.TRANFORM_KEY_TAG_NAME:
            self.TRANFORM_KEY_TAG_NAME = f'text-output://{self.endpoint.getConfigSubKey()}/status'.replace('\\', '/')

    def endInstance(self):
        """Call from engLib, Instance cleanup."""
        pass

    def writeTextBegin(self):
        self.target_object_text = ''

    def writeText(self, text: str):
        self.target_object_text = self.target_object_text + text

    def open(self, object: Entry):
        """Call from engLib, process object startup."""
        self.current_object = object
        self.target_object_text = ''
        # Build full path of target object
        self.target_object_path = f'//{self.IEndpoint.server}/{self.instance.targetObjectPath}.txt'

        try:
            # Get key of the last transform
            prev_transform_key = self.current_object.instanceTags.get(self.TRANFORM_KEY_TAG_NAME, '')

            # Get actual transform key
            transform_key = self.get_transform_key()
        except Exception:
            self.handle_object_error()

        # Skip transform if target file exists and
        # source and target files are matched and not changed
        if not self.current_object.objectFailed and transform_key == prev_transform_key and not self.IEndpoint.settings_changed:
            self.skip_object('object transformed and not changed')

    def close(self):
        """Call from engLib, process object complete."""
        if not self.current_object.objectFailed:
            try:
                # Write only non-empty file
                if self.target_object_text:
                    # Ensure, target directory exists with minor optimization - don't call SMB function if directory hasn't changed
                    target_dir_path = dirname(self.target_object_path)
                    if self.target_dir_path != target_dir_path:
                        smbclient.makedirs(target_dir_path, True)
                        self.target_dir_path = target_dir_path

                    # Write target file in UTF-8
                    with smbclient.open_file(self.target_object_path, 'w', encoding='utf8') as f:
                        f.write(self.target_object_text)

                    # Get updated transformation key
                    transform_key = self.get_transform_key()

                    # Store transformation key to persistent storage
                    self.current_object.instanceTags[self.TRANFORM_KEY_TAG_NAME] = transform_key

                    engLib.debug('Transform completed:', f'[{self.current_object.path}]:[{self.target_object_path}]')

                # Don't write empty file
                else:
                    self.skip_object('no text extracted')

            except Exception:
                self.handle_object_error()

        # Reset current object context
        self.current_object = None
        self.target_object_path = None
        self.target_object_text = None

    def get_transform_key(self) -> str:
        """Build transform key for current object."""
        source_change_key = self.current_object.changeKey or f'{self.current_object.modifyTime};{self.current_object.size}'

        target_change_key = None
        try:
            stat = smbclient.stat(self.target_object_path)
            target_change_key = f'{int(stat.st_mtime):x};{stat.st_size:x}'
        except SMBOSError as e:
            if e.errno != errno.ENOENT:
                raise
            target_change_key = '0;0'

        return f'{self.current_object.flags};{source_change_key};{target_change_key}'

    def handle_object_error(self):
        """Update current object with error details of exeption occurred."""
        try:
            raise
        except BaseException as e:
            self.current_object.completionCode(e)

    def skip_object(self, msg: str):
        """Skip further processing of the current object."""
        engLib.debug('Transform skipped:', msg, f'[{self.current_object.path}]')
        self.current_object.completionCode(Ec.Skipped, msg)

    #
    # Current object context properties
    #
    current_object: Entry = None
    target_object_path: str = None
    target_dir_path: str = None
    target_object_text: str = None
