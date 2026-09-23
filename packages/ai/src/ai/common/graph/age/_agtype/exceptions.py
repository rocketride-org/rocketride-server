# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.


class AgeNotSet(Exception):
    def __init__(self, name=None):
        self.name = name
        super().__init__(name or 'AGE extension is not set.')

    def __repr__(self):
        return 'AGE extension is not set.'

class GraphNotFound(Exception):
    def __init__(self, name=None):
        self.name = name
        super().__init__(f'Graph[{name}] does not exist.' if name else 'Graph does not exist.')

    def __repr__(self):
        if self.name:
            return 'Graph[' + self.name + '] does not exist.'
        return 'Graph does not exist.'


class GraphAlreadyExists(Exception):
    def __init__(self, name=None):
        self.name = name
        super().__init__(f'Graph[{name}] already exists.' if name else 'Graph already exists.')

    def __repr__(self):
        if self.name:
            return 'Graph[' + self.name + '] already exists.'
        return 'Graph already exists.'


class InvalidGraphName(Exception):
    """Raised when a graph name contains invalid characters."""
    def __init__(self, name, reason=None):
        self.name = name
        self.reason = reason
        msg = f"Invalid graph name: '{name}'."
        if reason:
            msg += f" {reason}"
        super().__init__(msg)

    def __repr__(self):
        return f"InvalidGraphName('{self.name}')"


class InvalidIdentifier(Exception):
    """Raised when an identifier (column, label, etc.) is invalid."""
    def __init__(self, name, context=None):
        self.name = name
        self.context = context
        msg = f"Invalid identifier: '{name}'."
        if context:
            msg += f" {context}"
        super().__init__(msg)

    def __repr__(self):
        return f"InvalidIdentifier('{self.name}')"


class GraphNotSet(Exception):
    def __repr__(self):
        return 'Graph name is not set.'


class NoConnection(Exception):
    def __repr__(self):
        return 'No Connection'

class NoCursor(Exception):
    def __repr__(self):
        return 'No Cursor'

class SqlExecutionError(Exception):
    def __init__(self, msg, cause):
        self.msg = msg
        self.cause = cause
        super().__init__(msg, cause)

    def __repr__(self):
        return 'SqlExecution [' + self.msg + ']'

class AGTypeError(Exception):
    def __init__(self, msg, cause):
        self.msg = msg
        self.cause = cause
        super().__init__(msg, cause)
