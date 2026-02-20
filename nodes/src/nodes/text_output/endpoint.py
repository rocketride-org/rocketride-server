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

import errno
import re
import smbclient
from smbprotocol.exceptions import SMBOSError
from threading import Lock
from typing import Any
from zlib import crc32

import engLib
from engLib import Filters


class Endpoint:
    """General connection to integration target 'Text Output'."""

    def beginEndpoint(self):
        """Call from engLib, Endpoint initialization."""
        # Connect and open key-value storage only when action is running
        if self.task_type == 'action':
            self.connect()

    def endEndpoint(self):
        """Call from engLib, Endpoint cleanup."""
        pass

    def validateConfig(self, syntaxOnly: bool):
        """Call from engLib, Endpoint configuration validation.

        Args:
            syntaxOnly (bool): if true, then do not connect, but only validate the syntax of parameters.
        """
        try:
            # RFC-1123
            IP_REGEX = r'^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$'
            HOSTNAME_REGEX = r'^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$'
            SERVER_REGEX = f'{IP_REGEX}|{HOSTNAME_REGEX}'
            Endpoint.validate_param('Server Name', self.server, pattern=SERVER_REGEX)

            Endpoint.validate_param('User Name', self.username, is_required=bool(self.password), validator=Endpoint.validate_smb_username)
            Endpoint.validate_param('Password', self.password, is_required=bool(self.username), max_length=127)
            Endpoint.validate_param('Store Path', self.store_path, min_lenght=3, max_length=256, validator=Endpoint.validate_smb_path)
            Endpoint.validate_param('Anonymization Character', self.anonymize_char, is_required=self.anonymize, min_lenght=1, max_length=1)

            if not syntaxOnly:
                # Do not try to connect as validation is run by Platform
                # where SMB share may not be available
                # self.connect()
                pass

        except ValueError as e:
            engLib.error(e)

    def getConfigSubKey(self):
        """Call from engLib, target service uniqueness key."""
        if self.endpoint.serviceMode == 1:  # source mode
            raise Exception('Source mode not supported')
        else:  # target mode
            return f'{self.server}/{self.store_path}'.lower()

    def getPipeFilters(self):
        """Call from engLib, list of pipe filters."""
        if self.anonymize:
            self.endpoint.taskConfig['wantsPolicies'] = False
            self.endpoint.taskConfig['wantsContext'] = False
            self.endpoint.taskConfig['wantsText'] = True
            return [Filters.CLASSIFY, 'anonymize_text']

        else:
            return []

    def connect(self):
        """Authenticate and test connection to the target share.

        according to the configuration parameters.

        Raise:
            An exception if connection failed.
        """
        # Setup user name and password
        if self.username and self.password:
            smbclient.ClientConfig(username=self.username, password=self.password)

        # Build paths to check
        share = next(iter(re.split(r'[\\/]', self.store_path)), None)
        server_path = f'//{self.server}/{share}'
        server_store_path = f'//{self.server}/{self.store_path}'

        # Server path should be available
        smbclient.stat(server_path)

        try:
            # Check full store path for existence
            smbclient.stat(server_store_path)
        except SMBOSError as e:
            # Re-raise if it is not 'File not found'
            if e.errno != errno.ENOENT:
                raise

        engLib.debug('Connected', server_path)

    @staticmethod
    def validate_param(param_name: str, param_value: str, is_required: bool = True, min_lenght: int = None, max_length: int = None, pattern: str = None, validator: Any = None) -> bool:
        """Validate parameter to match the requirements."""
        if not param_value:
            if is_required:
                raise ValueError(f'{param_name} not specified')
            else:
                return

        if min_lenght is not None and len(param_value) < min_lenght:
            raise ValueError(f'{param_name} too short')

        if max_length is not None and len(param_value) > max_length:
            raise ValueError(f'{param_name} too long')

        if pattern and not re.match(pattern, param_value):
            raise ValueError(f'{param_name} not valid')

        if validator:
            try:
                validator(param_value)
            except ValueError as e:
                raise ValueError(f'{param_name} {e}')

    @staticmethod
    def validate_smb_username(username: str):
        m = re.match(r'^(.+)\\(.+)$', username)
        if not m:
            raise ValueError('should be specified using domain-like format')
        # domain = m.group(1)
        # username = m.group(2)

    @staticmethod
    def validate_smb_path(smb_path: str):
        """Validate sub-path to be not rooted, not containing dot folders and special characters."""
        path_items = re.split(r'[\\/]', smb_path)
        for i, dir_name in enumerate(path_items):
            if i == 0:
                SHARE_REGEX = r"^[a-zA-Z0-9\s!@#$%&'_\-\.~\(\){}]{1,80}$"
                if not re.match(SHARE_REGEX, dir_name):
                    raise ValueError('Share Name not valid')
            if not dir_name and i < len(path_items) - 1:
                raise ValueError('should not be rooted' if i == 0 else 'should not contain empty folder')
            if dir_name == '.' or dir_name == '..':
                raise ValueError('should not contain dot-folders')
            if any(dir_name.find(c) != -1 for c in '<>:"|?*'):
                raise ValueError('contains invalid characters')

    def _settings_changed(self) -> bool:
        """Check classification settings and reset saved state if changed.

        Returns:
            * True if the settings have been changed
              and all objects are to be transformed,
              including unchanged objects from a previous transformation.
            * False if the settings have been changed and
              only new and changed objects need to be transformed.
        """
        if self.settings_changed_value is not None:
            return self.settings_changed_value

        with self.settings_changed_lock:
            if self.settings_changed_value is not None:
                return self.settings_changed_value

            # Current settings key
            settings_key = None
            if self.anonymize:
                # Calculate classify hash
                classify_hash = crc32(str(self.endpoint.taskConfig.get('classifyPolicies')).encode())
                settings_key = f'{classify_hash:x};{self.anonymize_char};{self.anonymize_all}'
            else:
                settings_key = ''

            # Last settings key
            prev_settings_key = self.endpoint.keystore.getValue(':settings-key:')

            # If settings changed...
            if settings_key != prev_settings_key:
                # Update settings key
                self.endpoint.keystore.setValue(':settings-key:', settings_key)

                self.settings_changed_value = True

            else:
                self.settings_changed_value = False

            return self.settings_changed_value

    #
    # Configuration parameters
    #
    task_type = property(lambda self: self.endpoint.jobConfig.get('type'))
    server = property(lambda self: self.endpoint.parameters.get('server'))
    username = property(lambda self: self.endpoint.parameters.get('username'))
    password = property(lambda self: self.endpoint.parameters.get('password'))
    anonymize = property(lambda self: self.endpoint.parameters.get('anonymize', False))
    store_path = property(lambda self: self.endpoint.parameters.get('storePath'))

    settings_changed: bool = property(lambda self: self._settings_changed())
    """
    Whether or not the transform related settings have been changed
    * True to transform all objects
    * False to transform only new and changed objects
    """
    settings_changed_value: bool = None
    settings_changed_lock = Lock()
