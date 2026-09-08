# =============================================================================
# RocketRide Engine
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

"""
Pipedrive tool mixins, one module per resource group.

``IInstance`` composes every mixin; which of their tools are actually published
is decided at runtime by the ``pipedrive.toolGroups`` config field.
"""

from ._base import PipedriveToolsBase
from .activities import ActivitiesMixin
from .call_logs import CallLogsMixin
from .deals import DealsMixin
from .fields import FieldsMixin
from .files import FilesMixin
from .filters import FiltersMixin
from .goals import GoalsMixin
from .leads import LeadsMixin
from .mailbox import MailboxMixin
from .misc import MiscMixin
from .notes import NotesMixin
from .organizations import OrganizationsMixin
from .persons import PersonsMixin
from .pipelines import PipelinesMixin
from .products import ProductsMixin
from .projects import ProjectsMixin
from .roles import RolesMixin
from .search import SearchMixin
from .subscriptions import SubscriptionsMixin
from .teams import TeamsMixin
from .users import UsersMixin
from .webhooks import WebhooksMixin

#: Order matters only for readability — the mixins do not override each other.
ALL_MIXINS = (
    DealsMixin,
    PersonsMixin,
    OrganizationsMixin,
    ActivitiesMixin,
    PipelinesMixin,
    NotesMixin,
    SearchMixin,
    LeadsMixin,
    ProductsMixin,
    FieldsMixin,
    FilesMixin,
    UsersMixin,
    RolesMixin,
    TeamsMixin,
    GoalsMixin,
    FiltersMixin,
    WebhooksMixin,
    SubscriptionsMixin,
    MailboxMixin,
    CallLogsMixin,
    ProjectsMixin,
    MiscMixin,
)

__all__ = [
    'ActivitiesMixin',
    'ALL_MIXINS',
    'CallLogsMixin',
    'DealsMixin',
    'FieldsMixin',
    'FilesMixin',
    'FiltersMixin',
    'GoalsMixin',
    'LeadsMixin',
    'MailboxMixin',
    'MiscMixin',
    'NotesMixin',
    'OrganizationsMixin',
    'PersonsMixin',
    'PipedriveToolsBase',
    'PipelinesMixin',
    'ProductsMixin',
    'ProjectsMixin',
    'RolesMixin',
    'SearchMixin',
    'SubscriptionsMixin',
    'TeamsMixin',
    'UsersMixin',
    'WebhooksMixin',
]
