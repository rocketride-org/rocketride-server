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

from ai.common.database import DatabaseInstanceBase
from .IGlobal import IGlobal
from .postgres_driver import PostgreSQLDriver


class IInstance(DatabaseInstanceBase):
    """PostgreSQL-specific instance state.

    The only PostgreSQL-specific knowledge here is which driver to instantiate.
    All lane handlers, SQL execution, and data insertion are in the base.
    """

    # Narrow the base type annotation to the concrete PostgreSQL IGlobal so
    # that IDE tooling resolves attributes like IGlobal.table without casting.
    IGlobal: IGlobal

    def _create_driver(self) -> PostgreSQLDriver:
        return PostgreSQLDriver(instance=self)
