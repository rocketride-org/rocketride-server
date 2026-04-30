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

import logging
import re
import engLib


class engLibHandler(logging.StreamHandler):
    """
    Redirect standard Python logging to engLib.

    Internal Sacumen library and other libraries use
    standard Python logging for output.
    """

    def emit(self, record):
        try:
            msg = self.format(record)

            # skip known warnings
            if any(
                name
                for levelno, name, pattern in self._known_errors
                if levelno == record.levelno and name == record.name and re.match(pattern, msg)
            ):
                return

            if record.levelno <= logging.INFO:
                engLib.debug(msg)
            elif record.levelno <= logging.WARNING:
                engLib.warning(msg)
            else:
                engLib.error(msg)
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception:
            self.handleError(record)

    # known warnings/errors (<levelno>, <full-name>, <message-pattern>)
    # TODO: figure out what are these warnings/errors about and how to fix/avoid
    # Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None))
    # after connection broken by 'ConnectTimeoutError(<urllib3.connection.HTTPConnection object at 0x0000027FB8212980>, 'Connection to 169.254.169.254 timed out. (connect timeout=None)')':
    # /metadata/instance/compute/location?format=text&api-version=2021-01-01
    _known_errors = [
        (
            logging.WARNING,
            'urllib3.connectionpool',
            r'^Retrying \(Retry\(total=(\d+|None), connect=(\d+|None), read=(\d+|None), redirect=(\d+|None), status=(\d+|None)\)\)'
            + r' after connection broken by'
            + r'.+(NewConnectionError|ConnectTimeoutError)'
            + r'.+<urllib3\.connection\.HTTPConnection object at 0x[0-9a-fA-F]+>'
            + r'.+/metadata/instance/compute/location\?format=text&api-version=\d\d\d\d-\d\d-\d\d$',
        ),
        (
            logging.WARNING,
            'msal.application',
            r"^Region configured \(('.*'|None)\) != region detected \(('.*'|None)\)$",
        ),
    ]


_logger = logging.getLogger()
_logger.setLevel(logging.DEBUG)
_logger.addHandler(engLibHandler())
