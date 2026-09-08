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

"""Call log tools, including uploading a call recording."""

from __future__ import annotations

import base64

from ..pipedrive_client import clean_call_log
from ..tool_groups import pipedrive_tool
from ._base import (
    ENUM,
    INT,
    PAGING,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    path_segment,
    require_text,
    schema,
)

_CALL_LOG_KEYS = (
    'subject',
    'duration',
    'outcome',
    'from_phone_number',
    'to_phone_number',
    'start_time',
    'end_time',
    'person_id',
    'org_id',
    'deal_id',
    'lead_id',
    'user_id',
    'activity_id',
    'note',
)


class CallLogsMixin(PipedriveToolsBase):
    """Tools for the ``call_logs`` group."""

    @pipedrive_tool(
        group='call_logs',
        input_schema=schema(**PAGING()),
        description='List the call logs of the authenticated user.',
    )
    def call_log_list(self, args):
        args = args_of(args)
        return self._list('/callLogs', args, clean_call_log)

    @pipedrive_tool(
        group='call_logs',
        input_schema=schema(required=['call_log_id'], call_log_id=STR('Call log id.')),
        description='Get a single call log.',
    )
    def call_log_get(self, args):
        args = args_of(args)
        log_id = require_text(args, 'call_log_id', 'call_log_get')
        return self._get(f'/callLogs/{path_segment(log_id)}', clean_call_log)

    @pipedrive_tool(
        group='call_logs',
        input_schema=schema(
            required=['outcome', 'to_phone_number', 'start_time', 'end_time'],
            subject=STR('Call subject. Defaults to the phone number.'),
            duration=INT('Call duration in seconds.'),
            outcome=ENUM(
                'How the call ended.',
                ['connected', 'no_answer', 'left_message', 'left_voicemail', 'wrong_number', 'busy'],
            ),
            from_phone_number=STR('Caller number.'),
            to_phone_number=STR('Number that was called.'),
            start_time=STR('Call start, RFC3339 UTC, e.g. "2026-07-26T10:00:00Z".'),
            end_time=STR('Call end, RFC3339 UTC.'),
            person_id=INT('Person the call relates to.'),
            org_id=INT('Organization the call relates to.'),
            deal_id=INT('Deal the call relates to.'),
            lead_id=STR('Lead uuid the call relates to.'),
            user_id=INT('User who made the call. Defaults to the authenticated user.'),
            activity_id=INT('Existing activity to attach the call to.'),
            note=STR('Free-text note about the call.'),
        ),
        description='Log a phone call.',
    )
    def call_log_create(self, args):
        args = args_of(args)
        for key in ('outcome', 'to_phone_number', 'start_time', 'end_time'):
            require_text(args, key, 'call_log_create')
        return self._write('POST', '/callLogs', clean_call_log, body=body_from(args, _CALL_LOG_KEYS))

    @pipedrive_tool(
        group='call_logs',
        input_schema=schema(required=['call_log_id'], call_log_id=STR('Call log id to delete.')),
        description='Delete a call log.',
    )
    def call_log_delete(self, args):
        args = args_of(args)
        log_id = require_text(args, 'call_log_id', 'call_log_delete')
        return self._delete(f'/callLogs/{path_segment(log_id)}')

    @pipedrive_tool(
        group='call_logs',
        input_schema=schema(
            required=['call_log_id', 'file_name', 'content_base64'],
            call_log_id=STR('Call log id.'),
            file_name=STR('Recording file name, including the extension (mp3, wav, ...).'),
            content_base64=STR('Recording contents, base64-encoded.'),
        ),
        description='Attach an audio recording to a call log.',
    )
    def call_log_recording_add(self, args):
        args = args_of(args)
        self._require_write()
        log_id = require_text(args, 'call_log_id', 'call_log_recording_add')
        file_name = require_text(args, 'file_name', 'call_log_recording_add')
        content_b64 = require_text(args, 'content_base64', 'call_log_recording_add')
        try:
            content = base64.b64decode(content_b64, validate=True)
        except Exception as exc:
            raise ValueError('call_log_recording_add: "content_base64" is not valid base64') from exc
        files = {'file': (file_name, content)}
        return self._call('POST', f'/callLogs/{path_segment(log_id)}/recordings', files=files)
