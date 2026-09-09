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

"""Conversation tools: the thread a contact's messages hang off, and its read and starred state."""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import paginated
from ..tool_groups import gohighlevel_tool
from ._base import (
    BOOL,
    ENUM,
    INT,
    LIST_OUTPUT,
    OBJ,
    PAGING_START_AFTER_DATE,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    params_from,
    require_id,
    schema,
    start_after_date_params,
    total_of,
)

#: Message-type values a conversation's last message can carry, verbatim from the
#: ``lastMessageType`` enum of ``GET /conversations/search``.
#:
#: The list is long and stays complete rather than being trimmed to the common values.
#: GoHighLevel validates an enum strictly and answers 422 for a value outside it, so a
#: shortened list would turn a legal filter into a hard vendor error the agent cannot act on.
_LAST_MESSAGE_TYPES = (
    'TYPE_CALL',
    'TYPE_SMS',
    'TYPE_RCS',
    'TYPE_EMAIL',
    'TYPE_SMS_REVIEW_REQUEST',
    'TYPE_WEBCHAT',
    'TYPE_SMS_NO_SHOW_REQUEST',
    'TYPE_CAMPAIGN_SMS',
    'TYPE_CAMPAIGN_CALL',
    'TYPE_CAMPAIGN_EMAIL',
    'TYPE_CAMPAIGN_VOICEMAIL',
    'TYPE_FACEBOOK',
    'TYPE_CAMPAIGN_FACEBOOK',
    'TYPE_CAMPAIGN_MANUAL_CALL',
    'TYPE_CAMPAIGN_MANUAL_SMS',
    'TYPE_GMB',
    'TYPE_CAMPAIGN_GMB',
    'TYPE_REVIEW',
    'TYPE_INSTAGRAM',
    'TYPE_WHATSAPP',
    'TYPE_CUSTOM_SMS',
    'TYPE_CUSTOM_EMAIL',
    'TYPE_CUSTOM_PROVIDER_SMS',
    'TYPE_CUSTOM_PROVIDER_EMAIL',
    'TYPE_IVR_CALL',
    'TYPE_ACTIVITY_CONTACT',
    'TYPE_ACTIVITY_INVOICE',
    'TYPE_ACTIVITY_PAYMENT',
    'TYPE_ACTIVITY_OPPORTUNITY',
    'TYPE_LIVE_CHAT',
    'TYPE_LIVE_CHAT_INFO_MESSAGE',
    'TYPE_ACTIVITY_APPOINTMENT',
    'TYPE_FACEBOOK_COMMENT',
    'TYPE_INSTAGRAM_COMMENT',
    'TYPE_CUSTOM_CALL',
    'TYPE_INTERNAL_COMMENT',
    'TYPE_ACTIVITY_EMPLOYEE_ACTION_LOG',
    'TYPE_TIKTOK',
    'TYPE_TIKTOK_COMMENT',
    'TYPE_ACTIVITY_WHATSAPP',
    'TYPE_FORM_SUBMISSION',
    'TYPE_SMS_REACTION',
)

#: Query keys conversation_search forwards, minus the ones the paging builder owns.
_SEARCH_KEYS = (
    'contactId',
    'assignedTo',
    'followers',
    'mentions',
    'query',
    'sort',
    'sortBy',
    'status',
    'lastMessageType',
    'lastMessageAction',
    'lastMessageDirection',
    'startDate',
    'endDate',
)

#: Body fields conversation_update accepts.
#:
#: There is no shared write-key tuple here, unlike contacts. CreateConversationDto declares
#: exactly ``locationId`` and ``contactId`` and UpdateConversationDto declares neither
#: ``contactId`` nor anything else the create takes, so the two operations share no field the
#: node does not supply itself. This is the same create-versus-update policy contacts.py sets
#: out: when the two DTOs disagree, each operation sends what its own DTO declares.
_CONVERSATION_UPDATE_KEYS = ('unreadCount', 'starred', 'feedback')

_CONVERSATION_UPDATE_PROPS = {
    'unreadCount': INT(
        'Number of unread messages to record on the conversation. Set 0 to mark it read: GoHighLevel has no '
        'mark-as-read endpoint, so writing this field is how reading is recorded.'
    ),
    'starred': BOOL('Whether the conversation is starred.'),
    'feedback': OBJ('Feedback payload. GoHighLevel declares it as a bare object and documents no fields inside it.'),
}

#: What a conversation read hands back, stated once because five tools return one.
#:
#: The ``type`` warning is not pedantry: the same field name is a string enum on the search
#: route and a small integer on the get route, so an agent that compares it across the two
#: gets a mismatch on identical data.
_CONVERSATION_SHAPE = (
    'Conversation dates are epoch milliseconds, not the ISO 8601 timestamps the rest of this node returns. '
    'The type field is a string like "TYPE_PHONE" on conversation_search and a number (1 Phone, 2 Email, '
    '3 Facebook Messenger, 4 Review, 5 Group SMS, 6 Internal Chat) on conversation_get, so do not compare '
    'the two directly.'
)

_CONVERSATION_RECORD_OUTPUT = RECORD_OUTPUT(f'The conversation, as GoHighLevel returns it. {_CONVERSATION_SHAPE}')


def _clean_conversation(conversation: Any) -> dict:
    """Normalise a conversation record without projecting it onto a key allowlist.

    Contacts are trimmed because their payload carries near-duplicate keys and a pagination
    cursor that belongs to the envelope. A conversation has neither: it is roughly fifteen
    small scalars, and the four routes that return one each send a different subset of them.
    A key allowlist would therefore have to be the union of four declared schemas, and those
    schemas are already known to under-declare (a live search response carries ``dateAdded``,
    which no declared conversation schema mentions). Dropping real data to enforce a list that
    is provably incomplete buys nothing, so this only guarantees the dict.
    """
    return conversation if isinstance(conversation, dict) else {}


def _search_cursor(records: Any, sort_by: Any) -> Any:
    """Style I cursor: the sort value carried by the last conversation of a page.

    This endpoint sends no cursor field. ``startAfterDate`` has to be the sort value of the
    last record, and which field holds that value depends on ``sortBy``. Only the default sort
    has a field name that can be named from the spec: ``last_message_date`` reads
    ``lastMessageDate``, declared on ConversationDto. The other four sort keys are snake_case
    strings whose matching response field GoHighLevel documents nowhere, and inventing a
    camelCase name for them would send a value the endpoint silently ignores, which re-fetches
    page one forever rather than failing. Any other sort therefore returns None and the
    listing stops after one page, which the tool description says outright.
    """
    if sort_by not in (None, '', 'last_message_date'):
        return None
    for record in reversed(list(records or [])):
        if isinstance(record, dict) and record.get('lastMessageDate') is not None:
            return record['lastMessageDate']
    return None


class ConversationsMixin(GoHighLevelToolsBase):
    """Tools for the ``conversations`` group."""

    @gohighlevel_tool(
        group='conversations',
        input_schema=schema(
            **PAGING_START_AFTER_DATE('conversation_search'),
            contactId=STR('Only conversations belonging to this contact.'),
            assignedTo=STR(
                'User ids the conversation is assigned to, comma separated. Pass "unassigned" for conversations '
                'nobody owns. Get user ids from user_list_by_location.'
            ),
            followers=STR('User ids of followers, comma separated.'),
            mentions=STR('User ids mentioned in the conversation, comma separated.'),
            query=STR('Free-text search across the conversation and its contact.'),
            sort=ENUM('Sort direction.', ('asc', 'desc')),
            sortBy=ENUM(
                'Field to sort on. Paging works only on the default, last_message_date.',
                ('last_manual_message_date', 'last_message_date', 'score_profile', 'overdue_at', 'due_at'),
            ),
            status=ENUM(
                'Read state to filter on. "recents" is accepted by the API but GoHighLevel documents no meaning '
                'for it.',
                ('all', 'read', 'unread', 'starred', 'recents'),
            ),
            lastMessageType=ENUM('Channel of the most recent message in the conversation.', _LAST_MESSAGE_TYPES),
            lastMessageAction=ENUM(
                'Whether the last outbound message was sent by a person or by automation.', ('automated', 'manual')
            ),
            lastMessageDirection=ENUM('Direction of the most recent message.', ('inbound', 'outbound')),
            startDate=INT('Earliest dateAdded to include, as epoch milliseconds.'),
            endDate=INT('Latest dateAdded to include, as epoch milliseconds.'),
        ),
        description=(
            'Find conversations in the configured sub-account, by contact, owner, channel, read state or free '
            'text. This is the only way to list conversations: GoHighLevel has no plain conversations list, and '
            'no endpoint that counts unread threads, so status="unread" here is how you find them. Returns '
            'conversations under items and, unusually for this API, a real total. next holds the value to pass '
            'back as startAfterDate, and is reported only while sortBy is left at its default: on any other sort '
            'GoHighLevel documents no field holding the sort value, so ask for a larger limit instead of paging. '
            f'{_CONVERSATION_SHAPE}'
        ),
        output_schema=LIST_OUTPUT(
            'Cursor for the next page: the sort value of the last conversation on this page. Pass it back as the '
            'startAfterDate parameter. Null when the page came back short, and also null on any sortBy other '
            'than last_message_date, where this endpoint cannot be paged.',
            items='The conversations on this page, as GoHighLevel returns them.',
        ),
    )
    def conversation_search(self, args):
        args = self._args(args, 'conversation_search')
        params, limit = start_after_date_params(args, 'conversation_search')
        params.update(params_from(args, _SEARCH_KEYS))
        params['locationId'] = self._location()
        payload, records = self._fetch('GET', '/conversations/search', key='conversations', params=params)
        return paginated(
            [_clean_conversation(record) for record in records],
            # GET /conversations/search is live-confirmed to send total beside conversations.
            total=total_of(payload),
            next_cursor=_search_cursor(records, args.get('sortBy')),
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='conversations',
        input_schema=schema(required=['conversationId'], conversationId=STR('Id of the conversation.')),
        description=(
            'Get one conversation by id, including how many of its messages are unread and who it is assigned '
            'to. Get the messages themselves from message_list. This route sends fewer fields than '
            f'conversation_search does, and it does not send the contact name, email or phone. '
            f'{_CONVERSATION_SHAPE}'
        ),
        output_schema=_CONVERSATION_RECORD_OUTPUT,
    )
    def conversation_get(self, args):
        args = self._args(args, 'conversation_get')
        conversation_id = require_id(args, 'conversationId', 'conversation_get')
        # This route answers the conversation bare while create and update wrap it under
        # "conversation". The key is named anyway: record_of applies it only when the payload
        # actually carries it, so naming it costs nothing and covers the wrapped shape too.
        return self._get(f'/conversations/{conversation_id}', _clean_conversation, key='conversation')

    @gohighlevel_tool(
        group='conversations',
        writes=True,
        input_schema=schema(
            required=['contactId'],
            contactId=STR('Id of the contact the conversation belongs to. Get contact ids from contact_search.'),
        ),
        description=(
            'Open a conversation with a contact in the configured sub-account. Only needed when there is not one '
            'already: message_send creates the conversation it needs on its own, and a contact that has ever '
            'been messaged already has one, which conversation_search will find. A conversation created here '
            'holds no messages.'
        ),
        output_schema=_CONVERSATION_RECORD_OUTPUT,
    )
    def conversation_create(self, args):
        args = self._args(args, 'conversation_create')
        body = body_from(args, ('contactId',), tool='conversation_create')
        body['locationId'] = self._location()
        # The trailing slash is load-bearing: /conversations without it is not this route.
        return self._write('POST', '/conversations/', _clean_conversation, key='conversation', body=body)

    @gohighlevel_tool(
        group='conversations',
        writes=True,
        input_schema=schema(
            required=['conversationId'],
            conversationId=STR('Id of the conversation to update.'),
            **_CONVERSATION_UPDATE_PROPS,
        ),
        description=(
            'Update a conversation read state, star or feedback. Only the fields you pass are changed. Setting '
            'unreadCount to 0 is how a conversation is marked read: GoHighLevel has no mark-as-read endpoint '
            'and no endpoint that reads unread counts back other than conversation_get and conversation_search. '
            'The contact a conversation belongs to cannot be changed here.'
        ),
        output_schema=_CONVERSATION_RECORD_OUTPUT,
    )
    def conversation_update(self, args):
        args = self._args(args, 'conversation_update')
        conversation_id = require_id(args, 'conversationId', 'conversation_update')
        body = body_from(args, _CONVERSATION_UPDATE_KEYS, tool='conversation_update')
        # UpdateConversationDto declares locationId required even though the id is in the path.
        body['locationId'] = self._location()
        return self._write(
            'PUT', f'/conversations/{conversation_id}', _clean_conversation, key='conversation', body=body
        )

    @gohighlevel_tool(
        group='conversations',
        writes=True,
        input_schema=schema(required=['conversationId'], conversationId=STR('Id of the conversation to delete.')),
        description=(
            'Delete a conversation and every message in it. The contact is not deleted. There is no undo and no '
            'endpoint that restores one, so prefer conversation_update when the intent is only to clear an '
            'unread badge.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def conversation_delete(self, args):
        args = self._args(args, 'conversation_delete')
        conversation_id = require_id(args, 'conversationId', 'conversation_delete')
        return self._delete(f'/conversations/{conversation_id}')
