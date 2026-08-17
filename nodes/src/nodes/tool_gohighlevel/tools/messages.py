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

"""Message tools: reading a conversation's messages, sending one, and cancelling a scheduled send.

One module, two groups. The five read tools are ``messages`` and ship in the default set;
``message_send`` and the two schedule-cancels are ``message_sending``, an explicit opt-in.
They are the only tools here whose write path has never been run against the live API (a
trial sub-account has no phone or email provider to send through), and a bad send is a
real SMS or email from an unattended pipeline. Until someone proves the send path against
a provisioned sub-account, publishing it should be a deliberate choice, not a default.
"""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import normalize_success, paginated
from ..tool_groups import gohighlevel_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    INT,
    LIST_OUTPUT,
    OBJ,
    PAGING_CURSOR,
    PAGING_LAST_MESSAGE_ID,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    cursor_params,
    last_message_id_params,
    next_cursor_of,
    params_from,
    passthrough,
    require_id,
    schema,
    total_of,
)

#: Channels ``message_send`` can originate a message on, verbatim from SendMessageBodyDto.
#:
#: There is deliberately no ``Call`` and no voicemail value. Calls and voicemails cannot be
#: originated through this API at all: they can only be logged after the fact, through the
#: inbound and outbound message endpoints, which this node does not publish because both need
#: a conversationProviderId that only a marketplace application can mint.
_SEND_TYPES = ('SMS', 'RCS', 'Email', 'WhatsApp', 'IG', 'FB', 'Custom', 'Live_Chat', 'TIKTOK')

#: Message-type values ``message_list`` filters on. Fewer than the 43 the conversation search
#: accepts, and the endpoint takes several of them at once as one comma-separated string, so
#: this is stated in prose rather than declared as an enum: an enum property would reject the
#: multi-value form the endpoint is built around.
_LIST_TYPES = (
    'TYPE_CALL, TYPE_SMS, TYPE_RCS, TYPE_EMAIL, TYPE_FACEBOOK, TYPE_GMB, TYPE_INSTAGRAM, TYPE_WHATSAPP, '
    'TYPE_ACTIVITY_APPOINTMENT, TYPE_ACTIVITY_CONTACT, TYPE_ACTIVITY_INVOICE, TYPE_ACTIVITY_PAYMENT, '
    'TYPE_ACTIVITY_OPPORTUNITY, TYPE_LIVE_CHAT, TYPE_INTERNAL_COMMENTS, TYPE_ACTIVITY_EMPLOYEE_ACTION_LOG, '
    'TYPE_TIKTOK, TYPE_ACTIVITY_WHATSAPP, TYPE_FORM_SUBMISSION'
)

#: Query keys ``message_export`` forwards, minus the ones the paging builder owns.
_EXPORT_KEYS = ('sortBy', 'sortOrder', 'conversationId', 'contactId', 'channel', 'startDate', 'endDate')

#: Body fields ``message_send`` accepts.
#:
#: There is no matching create-and-update pair here to share a tuple with: sending is the only
#: write on this surface, and a sent message cannot be edited. ``subType`` and ``status`` are
#: in the list only so a rejected send can be retried with them; see the tool description.
_SEND_KEYS = (
    'type',
    'contactId',
    'message',
    'subject',
    'html',
    'attachments',
    'emailFrom',
    'emailTo',
    'emailCc',
    'emailBcc',
    'emailReplyMode',
    'replyMessageId',
    'threadId',
    'templateId',
    'appointmentId',
    'scheduledTimestamp',
    'usesNativeSchedulingAi',
    'optimizationPeriod',
    'fromNumber',
    'toNumber',
    'forward',
    'conversationProviderId',
    'customSubtypeId',
    'subType',
    'status',
)

_SEND_PROPS = {
    'type': ENUM(
        'Channel to send on. The channel has to be provisioned on the sub-account first, so a sub-account with '
        'no phone number cannot send SMS. There is no Call or voicemail value: this API cannot place calls.',
        _SEND_TYPES,
    ),
    'contactId': STR('Id of the contact to send to. Get contact ids from contact_search.'),
    'message': STR('Plain-text body of the message. Use this for SMS and for a plain-text email.'),
    'subject': STR('Subject line. Email only.'),
    'html': STR('HTML body. Email only, and it replaces message rather than accompanying it.'),
    'attachments': ARR('Publicly reachable URLs to attach. This API takes URLs, never file uploads.'),
    'emailFrom': STR('Address to send from. Email only, and it must be an address the sub-account can send as.'),
    'emailTo': STR('Address to send to, when it is not the contact primary email. Email only.'),
    'emailCc': ARR('Addresses to copy. Email only.'),
    'emailBcc': ARR('Addresses to blind copy. Email only.'),
    'emailReplyMode': ENUM(
        'Who a reply goes to. Email only, and only meaningful with replyMessageId.', ('reply', 'reply_all')
    ),
    'replyMessageId': STR('Id of the message being replied to. Get message ids from message_list.'),
    'threadId': STR('Id of the thread to append to. For email this is the id of the message that opened it.'),
    'templateId': STR(
        'Id of a saved GoHighLevel template to send. This node has no tool that lists templates, so the id has '
        'to come from the GoHighLevel UI.'
    ),
    'appointmentId': STR('Id of an appointment to associate the message with.'),
    'scheduledTimestamp': INT(
        'When to send, as epoch SECONDS, not milliseconds. This is the only field in this node measured in '
        'seconds, and a millisecond value schedules the message tens of thousands of years out. Cancel a '
        'scheduled send with message_schedule_cancel.'
    ),
    'usesNativeSchedulingAi': BOOL('Whether GoHighLevel picks the send time within optimizationPeriod.'),
    'optimizationPeriod': ENUM('Window the scheduling AI may pick a send time inside.', ('24h', '48h', '72h')),
    'fromNumber': STR('Number to send from, in E.164 form. It must belong to the sub-account.'),
    'toNumber': STR('Number to send to, in E.164 form, when it is not the contact primary phone.'),
    'forward': OBJ(
        'Forwarding settings for an email, holding isForwarded, forwardWholeThread, messageId, emailMessageId '
        'and toEmail.'
    ),
    'conversationProviderId': STR(
        'Id of the conversation provider to send through. Only for a custom provider, and only a marketplace '
        'application can mint one, so leave it unset on a Private Integration Token.'
    ),
    'customSubtypeId': STR('Custom subtype id governing email unsubscribe preferences. Email only.'),
    'subType': OBJ(
        'GoHighLevel marks this required and then types it as an object while giving a string as its example, '
        'which reads as a defect in the published schema. This tool does not send it unless you do. Set it only '
        'if a send is rejected for a missing subType.'
    ),
    'status': ENUM(
        'Delivery outcome to stamp on the message. GoHighLevel marks this required, which reads as a defect: a '
        'delivery outcome is something the platform reports, not something a sender chooses, and setting it may '
        'have real effects on reporting. This tool does not send it unless you do.',
        ('delivered', 'failed', 'pending', 'read'),
    ),
}

#: What a message read hands back, stated once because three tools return one.
_MESSAGE_SHAPE = (
    'A message carries both a numeric type and a string messageType naming the same channel. Its attachments '
    'array is empty for calls and voicemails whatever the message actually held, because GoHighLevel serves '
    'recordings from a separate binary endpoint this node does not publish.'
)


def _clean_message(message: Any) -> dict:
    """Normalise a message record without projecting it onto a key allowlist.

    Same call as ``_clean_conversation`` and for the same reason: a message is a short, flat
    record with no near-duplicate keys and no embedded cursor, and the four routes that return
    one send different subsets, so a key allowlist would be the union of four schemas and would
    still drop whatever GoHighLevel adds next. This only guarantees the dict.
    """
    return message if isinstance(message, dict) else {}


def _next_page_flag(payload: Any) -> Any:
    """``nextPage`` from a message list, or None when the response omits it.

    Worth reading rather than inferring: this is the one endpoint on the whole surface that
    states outright whether another page exists, so it beats comparing the record count to the
    requested limit. None is returned for an absent field so :func:`paginated` falls back to
    that comparison instead of reading a missing flag as "no more pages".
    """
    if isinstance(payload, dict) and 'nextPage' in payload:
        return payload['nextPage']
    return None


def _last_message_id(payload: Any, records: Any) -> Any:
    """Style H cursor: the id of the last message on the page.

    The response root carries it under ``lastMessageId``, which is preferred, but it is read
    off the final record when the root omits it: the cursor is what the next call sends and a
    missing one silently ends the traversal.
    """
    if isinstance(payload, dict) and payload.get('lastMessageId'):
        return payload['lastMessageId']
    for record in reversed(list(records or [])):
        if isinstance(record, dict) and record.get('id'):
            return record['id']
    return None


def _cancel_result(payload: Any) -> dict:
    """Outcome of cancelling a scheduled send.

    These two endpoints do not answer with a success flag. They answer with an HTTP-style
    ``status`` number and a ``message``, and the shape GoHighLevel documents for the success
    case is an example reading ``404`` with "Failed cancel the scheduled message". A body that
    reports a 4xx therefore has to be read as a failure even though the HTTP response was a
    2xx, otherwise a cancellation that did not happen is reported as one that did.
    """
    if not isinstance(payload, dict):
        # No parsable body means no confirmation. A cancellation that cannot be confirmed is
        # reported as not done, for the same reason a 4xx inside a 2xx body is.
        return {'ok': False, 'status': None, 'message': 'GoHighLevel returned no cancellation confirmation.'}
    ok = normalize_success(payload)
    status = payload.get('status')
    try:
        if status is not None and int(status) >= 400:
            ok = False
    except (TypeError, ValueError):
        pass
    return {'ok': ok, 'status': status, 'message': payload.get('message') or ''}


class MessagesMixin(GoHighLevelToolsBase):
    """Tools for the ``messages`` group."""

    # -- reading -----------------------------------------------------------

    @gohighlevel_tool(
        group='messages',
        input_schema=schema(
            required=['conversationId'],
            conversationId=STR('Id of the conversation. Get conversation ids from conversation_search.'),
            type=STR(f'Message types to include, comma separated. One or more of: {_LIST_TYPES}.'),
            **PAGING_LAST_MESSAGE_ID('message_list'),
        ),
        description=(
            'Read the messages in one conversation. This is the tool for "what did we say to this '
            'contact": find the conversation with conversation_search, then read it here. The list includes '
            'activity entries (appointments, opportunity changes) as well as real messages, so pass type to '
            'narrow it. next holds the id of the last message on the page: pass it back as lastMessageId, and '
            f'ask for another page only while has_more is true. {_MESSAGE_SHAPE}'
        ),
        output_schema=LIST_OUTPUT(
            'Cursor for the next page: the id of the last message on this page. Pass it back as the '
            'lastMessageId parameter. Null when GoHighLevel reports no further page.',
            items='The messages on this page, as GoHighLevel returns them.',
        ),
    )
    def message_list(self, args):
        args = self._args(args, 'message_list')
        conversation_id = require_id(args, 'conversationId', 'message_list')
        params, limit = last_message_id_params(args, 'message_list')
        params.update(params_from(args, ('type',)))
        payload, records = self._fetch(
            'GET', f'/conversations/{conversation_id}/messages', key='messages', params=params
        )
        return paginated(
            [_clean_message(record) for record in records],
            next_cursor=_last_message_id(payload, records),
            has_more=_next_page_flag(payload),
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='messages',
        input_schema=schema(required=['messageId'], messageId=STR('Id of the message.')),
        description=(
            'Get one message by id, including its body, direction, delivery status and attachment URLs. Use '
            'message_email_get instead for an email, which carries the subject, recipients and thread that this '
            f'route leaves out. {_MESSAGE_SHAPE}'
        ),
        output_schema=RECORD_OUTPUT(f'The message, as GoHighLevel returns it. {_MESSAGE_SHAPE}'),
    )
    def message_get(self, args):
        args = self._args(args, 'message_get')
        message_id = require_id(args, 'messageId', 'message_get')
        # The path is written out here rather than taken from the spec on purpose: GoHighLevel
        # declares no id parameter on this operation, so its own generated SDK requests the
        # literal string "/conversations/messages/{id}" and never substitutes anything.
        return self._get(f'/conversations/messages/{message_id}', _clean_message)

    @gohighlevel_tool(
        group='messages',
        input_schema=schema(required=['emailMessageId'], emailMessageId=STR('Id of the email message.')),
        description=(
            'Get one email message by id, with its subject, sender, to, cc and bcc lists, thread id and '
            'attachment URLs. The id is the emailMessageId that message_send returns for an email, which is a '
            'different id from the messageId it returns alongside it. Every other message type reads through '
            'message_get.'
        ),
        output_schema=RECORD_OUTPUT(
            'The email message, as GoHighLevel returns it. from is a single string holding the sender name and '
            'address together, while to, cc and bcc are arrays of addresses.'
        ),
    )
    def message_email_get(self, args):
        args = self._args(args, 'message_email_get')
        email_message_id = require_id(args, 'emailMessageId', 'message_email_get')
        # Hand-written for the same reason as message_get: this operation declares no
        # parameters at all, so nothing can substitute the id for us.
        return self._get(f'/conversations/messages/email/{email_message_id}', _clean_message)

    @gohighlevel_tool(
        group='messages',
        input_schema=schema(
            **PAGING_CURSOR('message_export'),
            conversationId=STR('Only messages in this conversation.'),
            contactId=STR('Only messages exchanged with this contact.'),
            channel=ENUM(
                'Channel to include. Leaving it unset returns every non-email message, including activity '
                'entries, and excludes email, so pass "Email" explicitly to export email.',
                ('Call', 'SMS', 'Email', 'WhatsApp', 'Instagram', 'Facebook'),
            ),
            startDate=STR('Earliest message to include, as an ISO 8601 timestamp.'),
            endDate=STR('Latest message to include, as an ISO 8601 timestamp.'),
            sortBy=ENUM('Field to sort on. Defaults to createdAt.', ('createdAt', 'updatedAt')),
            sortOrder=ENUM('Sort direction. Defaults to desc.', ('asc', 'desc')),
        ),
        description=(
            'Export messages across the whole configured sub-account, rather than one conversation at a time. '
            'Use this for bulk reads and reporting; use message_list to read a single thread. Email is excluded '
            'unless you pass channel="Email". Returns a real total and pages 10 to 500 at a time. next holds an '
            'opaque cursor: pass it back unchanged, and ask for another page only while has_more is true.'
        ),
        output_schema=LIST_OUTPUT(
            'Cursor for the next page: an opaque token. Pass it back unchanged as the cursor parameter. Null '
            'when there is no next page.',
            items='The messages on this page, as GoHighLevel returns them.',
        ),
    )
    def message_export(self, args):
        args = self._args(args, 'message_export')
        params, limit = cursor_params(args, 'message_export')
        params.update(params_from(args, _EXPORT_KEYS))
        params['locationId'] = self._location()
        payload, records = self._fetch('GET', '/conversations/messages/export', key='messages', params=params)
        return paginated(
            [_clean_message(record) for record in records],
            # GET /conversations/messages/export is the one messages route that declares total.
            total=total_of(payload),
            next_cursor=next_cursor_of(payload),
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='messages',
        input_schema=schema(required=['messageId'], messageId=STR('Id of the call or voicemail message.')),
        description=(
            'Get the speech-to-text transcription of a recorded call or voicemail. Only messages GoHighLevel has '
            'transcribed have one, so this returns nothing useful for an SMS or an email. The audio itself is '
            'served as a binary download and is not reachable from this node.'
        ),
        output_schema=RECORD_OUTPUT(
            'The transcription as GoHighLevel returns it, passed through untouched. It is declared as one object '
            'holding transcript, mediaChannel, sentenceIndex, startTime and endTime in milliseconds, and '
            'confidence, but the presence of sentenceIndex suggests a per-sentence array, so handle both.'
        ),
    )
    def message_transcription_get(self, args):
        args = self._args(args, 'message_transcription_get')
        message_id = require_id(args, 'messageId', 'message_transcription_get')
        # The sub-account goes in the path here, and it comes BEFORE the message id. The
        # recording endpoint nests the same two ids the other way round.
        path = f'/conversations/locations/{self._location()}/messages/{message_id}/transcription'
        return self._get(path, passthrough)

    # -- sending -----------------------------------------------------------

    @gohighlevel_tool(
        group='message_sending',
        writes=True,
        input_schema=schema(required=['type', 'contactId'], **_SEND_PROPS),
        description=(
            'Send a message to a contact on any channel: SMS, email, WhatsApp, Instagram, Facebook, RCS, TikTok, '
            'live chat or a custom provider. One tool covers every channel, selected by type; there is no '
            'per-channel send endpoint, and no way to place a call or leave a voicemail. GoHighLevel opens the '
            'conversation if the contact does not have one. The channel has to be provisioned on the sub-account '
            'first, so a send fails on an account with no phone number or no email provider however well formed '
            'the request is. Pass scheduledTimestamp, in epoch SECONDS, to schedule instead of sending now. '
            'GoHighLevel also marks subType and status required, which reads as a defect in its published '
            'schema, so this tool sends neither unless you set them.'
        ),
        output_schema=RECORD_OUTPUT(
            'conversationId and messageId identify what was sent. An email also carries emailMessageId, which is '
            'a different id and the one message_email_get takes. A Google My Business send returns messageIds, '
            'an array, instead of messageId. status is the delivery state at the moment of sending.'
        ),
    )
    def message_send(self, args):
        args = self._args(args, 'message_send')
        body = body_from(args, _SEND_KEYS, tool='message_send')
        # No locationId anywhere: this operation takes the sub-account from the token alone,
        # and sending one is a 422 rather than a no-op.
        return self._write('POST', '/conversations/messages', _clean_message, body=body)

    @gohighlevel_tool(
        group='message_sending',
        writes=True,
        input_schema=schema(required=['messageId'], messageId=STR('Id of the scheduled message.')),
        description=(
            'Cancel a message that was scheduled but has not gone out yet. Only useful for a send that carried '
            'scheduledTimestamp. Use message_email_schedule_cancel for a scheduled email, which is keyed by its '
            'own emailMessageId. Check ok on the result: this endpoint reports a failed cancellation in the '
            'response body rather than as an error.'
        ),
        output_schema=RECORD_OUTPUT(
            'ok is true when the message was actually cancelled, with the code GoHighLevel reported under status '
            'and its own wording under message.'
        ),
    )
    def message_schedule_cancel(self, args):
        args = self._args(args, 'message_schedule_cancel')
        message_id = require_id(args, 'messageId', 'message_schedule_cancel')
        return self._write('DELETE', f'/conversations/messages/{message_id}/schedule', _cancel_result)

    @gohighlevel_tool(
        group='message_sending',
        writes=True,
        input_schema=schema(
            required=['emailMessageId'],
            emailMessageId=STR('Id of the scheduled email, which is the emailMessageId message_send returned.'),
        ),
        description=(
            'Cancel a scheduled email that has not gone out yet. Emails are keyed by emailMessageId rather than '
            'by the messageId message_schedule_cancel takes, and the two ids are different values for the same '
            'send. Check ok on the result: this endpoint reports a failed cancellation in the response body '
            'rather than as an error.'
        ),
        output_schema=RECORD_OUTPUT(
            'ok is true when the email was actually cancelled, with the code GoHighLevel reported under status '
            'and its own wording under message.'
        ),
    )
    def message_email_schedule_cancel(self, args):
        args = self._args(args, 'message_email_schedule_cancel')
        email_message_id = require_id(args, 'emailMessageId', 'message_email_schedule_cancel')
        path = f'/conversations/messages/email/{email_message_id}/schedule'
        return self._write('DELETE', path, _cancel_result)
