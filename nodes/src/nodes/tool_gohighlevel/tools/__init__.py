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
GoHighLevel tool mixins, one module per resource group.

``IInstance`` composes every mixin; which of their tools are actually published is
decided at runtime by the ``gohighlevel.toolGroups`` and ``gohighlevel.readOnly``
config fields.

This module is the composition registry. A new group module is registered by adding
its import, one entry to :data:`ALL_MIXINS` and one entry to ``__all__``.
"""

from __future__ import annotations

from ._base import GoHighLevelToolsBase
from .appointment_notes import AppointmentNotesMixin
from .appointments import AppointmentsMixin
from .businesses import BusinessesMixin
from .calendar_groups import CalendarGroupsMixin
from .calendars import CalendarsMixin
from .contact_notes import ContactNotesMixin
from .contact_tasks import ContactTasksMixin
from .contacts import ContactsMixin
from .conversations import ConversationsMixin
from .custom_fields import CustomFieldsMixin
from .custom_values import CustomValuesMixin
from .location_tags import LocationTagsMixin
from .locations import LocationsMixin
from .messages import MessagesMixin
from .opportunities import OpportunitiesMixin
from .pipelines import PipelinesMixin
from .users import UsersMixin

#: Order matters only for readability: the mixins do not override each other. Kept
#: alphabetical so it can be read against the ``IInstance`` bases at a glance.
ALL_MIXINS = (
    AppointmentNotesMixin,
    AppointmentsMixin,
    BusinessesMixin,
    CalendarGroupsMixin,
    CalendarsMixin,
    ContactNotesMixin,
    ContactTasksMixin,
    ContactsMixin,
    ConversationsMixin,
    CustomFieldsMixin,
    CustomValuesMixin,
    LocationTagsMixin,
    LocationsMixin,
    MessagesMixin,
    OpportunitiesMixin,
    PipelinesMixin,
    UsersMixin,
)

__all__ = [
    'ALL_MIXINS',
    'AppointmentNotesMixin',
    'AppointmentsMixin',
    'BusinessesMixin',
    'CalendarGroupsMixin',
    'CalendarsMixin',
    'ContactNotesMixin',
    'ContactsMixin',
    'ContactTasksMixin',
    'ConversationsMixin',
    'CustomFieldsMixin',
    'CustomValuesMixin',
    'GoHighLevelToolsBase',
    'LocationsMixin',
    'LocationTagsMixin',
    'MessagesMixin',
    'OpportunitiesMixin',
    'PipelinesMixin',
    'UsersMixin',
]
