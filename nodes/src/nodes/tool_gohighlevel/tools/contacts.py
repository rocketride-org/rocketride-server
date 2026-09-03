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

"""Contact tools: the contact record plus its tags, followers, workflows and appointments."""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import paginated, split_custom_fields
from ..tool_groups import gohighlevel_tool
from ._base import (
    ARR,
    BOOL,
    CUSTOM_FIELDS_DESC,
    EXTRA,
    LIST_OUTPUT,
    MIXED_ARR,
    OBJ,
    PAGING_SEARCH_AFTER,
    PAGING_SKIP_TEXT,
    PAGING_START_AFTER,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    flag_result,
    follower_result,
    next_offset,
    params_from,
    passthrough,
    record_of,
    require_id,
    schema,
    search_after_body,
    search_after_cursor,
    skip_text_params,
    start_after_cursor,
    start_after_params,
    upsert_result,
)

#: Fields kept from a contact record. The payload is not enormous, but it carries several
#: pairs of near-duplicate keys and a pagination cursor that belongs to the envelope rather
#: than to the record, and dropping those makes what is left readable.
#:
#: Both casing variants are kept deliberately. The two list routes disagree about which key
#: holds the display casing: GET /contacts/ returns ``firstName`` lowercased with the cased
#: value in ``firstNameRaw``, while POST /contacts/search returns ``firstName`` cased with the
#: lowercased value in ``firstNameLowerCase``. Keeping only one of them loses the real name on
#: one of the two routes.
_CONTACT_READ_KEYS = (
    'id',
    'locationId',
    'contactName',
    'firstName',
    'lastName',
    'firstNameRaw',
    'lastNameRaw',
    'name',
    'email',
    'additionalEmails',
    'phone',
    'additionalPhones',
    'companyName',
    'businessName',
    'businessId',
    'type',
    'source',
    'assignedTo',
    'address',
    'address1',
    'city',
    'state',
    'postalCode',
    'country',
    'website',
    'timezone',
    'dnd',
    'dndSettings',
    'inboundDndSettings',
    'dateOfBirth',
    'dateAdded',
    'dateUpdated',
    'lastActivity',
    'tags',
    'followers',
    'opportunities',
    'attributionSource',
    'lastAttributionSource',
    'attributions',
    'profilePhoto',
)

#: Body fields shared by the three write operations. contact_create extends this set (see
#: :data:`_CONTACT_CREATE_KEYS`); contact_upsert uses it as-is; contact_update narrows it.
#:
#: ``tags`` is deliberately absent here. Sending it replaces every tag on the contact rather
#: than adding to them, so it is destructive on update and on an upsert that resolves to an
#: update, and tag changes go through contact_tags_add and contact_tags_remove instead.
#: ``extra`` cannot smuggle it back in on those two either: :data:`EXTRA_FORBIDDEN` rejects it
#: before the request goes out. Only contact_create accepts tags, because a contact being
#: created has none to lose.
#:
#: ``locationId`` is absent too: the node supplies it from config on the two operations that
#: take it, and UpdateContactDto has no such property at all.
_CONTACT_WRITE_KEYS = (
    'firstName',
    'lastName',
    'name',
    'email',
    'phone',
    'gender',
    'companyName',
    'address1',
    'city',
    'state',
    'postalCode',
    'country',
    'website',
    'timezone',
    'source',
    'assignedTo',
    'dnd',
    'dndSettings',
    'inboundDndSettings',
    'dateOfBirth',
    'customFields',
)

#: Fields CreateContactDto and UpsertContactDto declare and UpdateContactDto does not.
#:
#: Verified against the vendor spec: both create bodies list ``gender`` and ``companyName``,
#: the update body lists neither. GoHighLevel rejects an undeclared property with a 422 rather
#: than ignoring it, so offering them on contact_update would show the agent two parameters
#: whose only outcome is a hard vendor error, which is exactly what the local argument check
#: exists to prevent. Update therefore gets its own key tuple and its own schema.
#:
#: This is the create-versus-update policy for the whole node: when the two DTOs disagree,
#: each operation sends what its own DTO declares. Several modules still to be written
#: (opportunities, appointments, tasks, notes) have the same drift.
_CREATE_ONLY_KEYS = ('gender', 'companyName')

#: Fields a create carries that mean the request is about a specific person.
#:
#: GoHighLevel rejects a create whose only content is the sub-account id, live-confirmed as an
#: HTTP 400 whose body claims 422, so this list is checked locally to turn that into a message
#: naming what to send.
_CONTACT_IDENTIFYING_KEYS = ('firstName', 'lastName', 'name', 'email', 'phone', 'companyName')

_CONTACT_WRITE_PROPS = {
    'firstName': STR('First name.'),
    'lastName': STR('Last name.'),
    'name': STR('Full name. Set this instead of firstName and lastName when you only have one string.'),
    'email': STR('Primary email address.'),
    'phone': STR('Primary phone number in E.164 form, for example "+18888888888".'),
    'gender': STR('Gender, for example "male".'),
    'companyName': STR('Company the contact belongs to.'),
    'address1': STR('Street address.'),
    'city': STR('City.'),
    'state': STR('State or region, for example "AL".'),
    'postalCode': STR('Postal code.'),
    'country': STR('2-letter country code, for example "US".'),
    'website': STR('Website URL.'),
    'timezone': STR('IANA timezone name, for example "America/Chihuahua".'),
    'source': STR('Where the contact came from. Free text that shows in the GoHighLevel UI.'),
    'assignedTo': STR('Id of the user the contact is assigned to. Get user ids from user_list_by_location.'),
    'dnd': BOOL('Whether to stop all outbound messaging to this contact.'),
    'dndSettings': OBJ(
        'Per-channel do-not-disturb settings, keyed by channel (Call, Email, SMS, WhatsApp, GMB, FB). '
        'Each value is an object with status, message and code.'
    ),
    'inboundDndSettings': OBJ('Inbound do-not-disturb settings, under an "all" key holding status and message.'),
    'dateOfBirth': STR('Birth date. YYYY-MM-DD is accepted, as are MM/DD/YYYY and several other separators.'),
    'customFields': MIXED_ARR(f'Custom field values to set. {CUSTOM_FIELDS_DESC}'),
    'extra': EXTRA(),
}

#: Body keys and schema properties for contact_create only.
#:
#: ``tags`` is safe here and nowhere else. GoHighLevel replaces the whole tag array rather than
#: appending to it, which is destructive on update and on an upsert that resolves to an update,
#: but a contact being created has no tags to lose. Tagging at create time also saves a request
#: against a measured 25-request/10s budget, so the alternative (create, then contact_tags_add)
#: is worse for the common "new lead arrives tagged" flow.
_CONTACT_CREATE_KEYS = _CONTACT_WRITE_KEYS + ('tags',)
_CONTACT_CREATE_PROPS = {
    **_CONTACT_WRITE_PROPS,
    'tags': ARR(
        'Tags to apply to the new contact. Safe on create because the contact has no tags yet. '
        'Use contact_tags_add on an existing contact: sending tags to contact_update or '
        'contact_upsert replaces every tag rather than adding to them.'
    ),
}

#: Body keys and schema properties for contact_update, which is the create set minus the two
#: fields UpdateContactDto does not declare.
_CONTACT_UPDATE_KEYS = tuple(key for key in _CONTACT_WRITE_KEYS if key not in _CREATE_ONLY_KEYS)
_CONTACT_UPDATE_PROPS = {key: prop for key, prop in _CONTACT_WRITE_PROPS.items() if key not in _CREATE_ONLY_KEYS}

#: What a contact read returns for custom fields, stated once because three tools return one.
_CONTACT_CUSTOM_FIELDS_READ = (
    'Custom field values come back as one object keyed by field id, or verbatim when GoHighLevel '
    'sends them in a shape this node does not recognise. Neither is the array shape contact_create '
    'and contact_update take.'
)

_CONTACT_RECORD_OUTPUT = RECORD_OUTPUT(
    f'The contact, trimmed to the fields this node returns. {_CONTACT_CUSTOM_FIELDS_READ}'
)

_CONTACT_ITEMS = 'The contacts on this page, each trimmed to the fields this node returns.'


def _clean_contact(contact: Any) -> dict:
    """Trim a contact record and project its custom fields into a dict keyed by field id.

    The projection is a best effort, not a filter. GoHighLevel's declared response schemas are
    unreliable and the custom-field shape already differs by route, so a value the projection
    does not recognise is passed through as it arrived rather than dropped: losing data
    silently is worse than handing the agent a shape it has to look at.
    """
    if not isinstance(contact, dict):
        return {}
    out = {key: contact[key] for key in _CONTACT_READ_KEYS if key in contact}
    raw = contact.get('customFields')
    if raw is not None:
        custom = split_custom_fields(raw)
        out['customFields'] = custom or raw
    return out


def _contact_total(payload: Any) -> Any:
    """Total record count for a contacts list, under whichever key that route reports it.

    The three contact list routes name it three ways and none of them always sends it, so this
    returns None rather than a synthesised number when it is absent.
    """
    if not isinstance(payload, dict):
        return None
    meta = payload.get('meta')
    if isinstance(meta, dict) and meta.get('total') is not None:
        return meta['total']
    for key in ('total', 'count'):
        if payload.get(key) is not None:
            return payload[key]
    return None


def _require_any_of(values: dict, keys: tuple[str, ...], tool: str, note: str = '') -> None:
    """Fail locally when a request carries none of the fields its endpoint needs.

    Several GoHighLevel operations declare every field optional and then reject the request
    that supplies none of them, with vendor wording the agent cannot act on. Checking here
    costs nothing and gives back a message naming the parameters that would satisfy it.

    ``values`` is the assembled body or query fragment rather than the raw arguments, so a
    field supplied through the ``extra`` escape hatch counts.

    This belongs in ``_base.py`` once a second module needs it: the remaining modules have at
    least one more at-least-one-of endpoint (calendar events want exactly one of userId,
    calendarId or groupId).
    """
    if any(values.get(key) is not None for key in keys):
        return
    listed = ', '.join(f'"{key}"' for key in keys)
    message = f'{tool}: pass at least one of {listed}.'
    raise ValueError(f'{message} {note}' if note else message)


def _tag_result(payload: Any) -> dict:
    """Tags reported back by a tag write, which is the contact's whole list rather than a delta."""
    if not isinstance(payload, dict):
        return {'tags': []}
    return {'tags': payload.get('tags') or []}


def _upsert_result(payload: Any) -> dict:
    """Upsert response: the contact, plus whether it was created rather than updated."""
    return upsert_result(payload, 'contact', _clean_contact)


class ContactsMixin(GoHighLevelToolsBase):
    """Tools for the ``contacts`` group."""

    # -- the contact record ------------------------------------------------

    @gohighlevel_tool(
        group='contacts',
        input_schema=schema(
            **PAGING_START_AFTER('contact_list'),
            query=STR('Free-text search across the contact record.'),
        ),
        description=(
            'List contacts in the configured sub-account. The only narrowing this endpoint offers is the '
            'free-text query parameter: it cannot filter on a named field, and GoHighLevel marks it deprecated '
            'in favour of contact_search. Reach for contact_search whenever you know anything about the contact '
            'you want (email, phone, name, tag) and use this one to scan the whole sub-account. Returns contacts '
            'under items. next holds {"startAfter", "startAfterId"}: pass those two values back as the startAfter '
            'and startAfterId parameters, and ask for another page only while has_more is true.'
        ),
        output_schema=LIST_OUTPUT(
            'Cursor for the next page: an object holding startAfter and startAfterId, taken from the last record '
            'of this page. Pass both back as the startAfter and startAfterId parameters. Null when the page came '
            'back short, which means there is no next page.',
            items=_CONTACT_ITEMS,
        ),
    )
    def contact_list(self, args):
        args = self._args(args, 'contact_list')
        params, limit = start_after_params(args, 'contact_list')
        params.update(params_from(args, ('query',)))
        params['locationId'] = self._location()
        payload, records = self._fetch('GET', '/contacts/', key='contacts', params=params)
        return paginated(
            [_clean_contact(record) for record in records],
            total=_contact_total(payload),
            next_cursor=start_after_cursor(records),
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='contacts',
        input_schema=schema(
            **PAGING_SEARCH_AFTER('contact_search'),
            filters=MIXED_ARR(
                'Filter clauses, each an object of the form '
                '{"field": "email", "operator": "eq", "value": "a@b.com"}. The operators confirmed to work are '
                '"eq" for an exact match and "contains" for a substring match; GoHighLevel publishes no list of '
                'the rest. Omit this to walk every contact in the sub-account.'
            ),
            sort=MIXED_ARR('Sort clauses, each an object naming a field and a direction.'),
        ),
        description=(
            'Find contacts in the configured sub-account by email, phone, name, tag or any other field. This is '
            'the successor to contact_list and the only contacts read that can filter, so prefer it for every '
            'lookup. Omit filters to walk the whole sub-account. Returns contacts under items. next holds an '
            'opaque searchAfter value: pass it back unchanged as the searchAfter parameter, and ask for another '
            'page only while has_more is true. Only "eq" and "contains" are confirmed to work, and GoHighLevel '
            'publishes no schema for this endpoint, so an unfamiliar filter shape is likely to be rejected '
            'rather than ignored.'
        ),
        output_schema=LIST_OUTPUT(
            'Cursor for the next page: the opaque searchAfter value carried by the last record of this page. '
            'Pass it back unchanged as the searchAfter parameter. Null when the page came back short, which '
            'means there is no next page.',
            items=_CONTACT_ITEMS,
        ),
    )
    def contact_search(self, args):
        args = self._args(args, 'contact_search')
        body, limit = search_after_body(args, 'contact_search')
        body.update(body_from(args, ('filters', 'sort')))
        body['locationId'] = self._location()
        payload, records = self._fetch('POST', '/contacts/search', key='contacts', body=body)
        return paginated(
            [_clean_contact(record) for record in records],
            total=_contact_total(payload),
            next_cursor=search_after_cursor(records),
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='contacts',
        input_schema=schema(required=['contactId'], contactId=STR('Id of the contact.')),
        description=(
            'Get one contact by id. The record carries the contact tags and followers inline, and those are the '
            'only way to read them: GoHighLevel has no endpoint that lists a contact tags, followers, campaigns '
            f'or workflows. {_CONTACT_CUSTOM_FIELDS_READ}'
        ),
        output_schema=_CONTACT_RECORD_OUTPUT,
    )
    def contact_get(self, args):
        args = self._args(args, 'contact_get')
        contact_id = require_id(args, 'contactId', 'contact_get')
        return self._get(f'/contacts/{contact_id}', _clean_contact, key='contact')

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(**_CONTACT_CREATE_PROPS),
        description=(
            'Create a contact in the configured sub-account. Pass at least one identifying field: a request '
            'carrying nothing but the sub-account id is rejected. Tags can be set here, because a contact being '
            'created has none to lose; on an existing contact use contact_tags_add instead, since GoHighLevel '
            'replaces the whole tag array rather than adding to it. Use contact_upsert instead when the contact '
            'may already exist.'
        ),
        output_schema=_CONTACT_RECORD_OUTPUT,
    )
    def contact_create(self, args):
        args = self._args(args, 'contact_create')
        body = body_from(args, _CONTACT_CREATE_KEYS, tool='contact_create', forbidden={})
        _require_any_of(
            body,
            _CONTACT_IDENTIFYING_KEYS,
            'contact_create',
            'GoHighLevel rejects a create carrying nothing but the sub-account id.',
        )
        body['locationId'] = self._location()
        return self._write('POST', '/contacts/', _clean_contact, key='contact', body=body)

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(
            required=['contactId'],
            contactId=STR('Id of the contact to update.'),
            **_CONTACT_UPDATE_PROPS,
        ),
        description=(
            'Update a contact. Only the fields you pass are changed. Tags cannot be changed here: the underlying '
            'field replaces every tag on the contact rather than adding to them, so this tool does not accept it '
            'and contact_tags_add and contact_tags_remove are the safe route. Sending customFields replaces only '
            'the fields you name. GoHighLevel does not accept gender or companyName on an update, so this tool '
            'does not offer them even though contact_create does.'
        ),
        output_schema=_CONTACT_RECORD_OUTPUT,
    )
    def contact_update(self, args):
        args = self._args(args, 'contact_update')
        contact_id = require_id(args, 'contactId', 'contact_update')
        body = body_from(args, _CONTACT_UPDATE_KEYS, tool='contact_update')
        return self._write('PUT', f'/contacts/{contact_id}', _clean_contact, key='contact', body=body)

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(required=['contactId'], contactId=STR('Id of the contact to delete.')),
        description='Delete a contact by id.',
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def contact_delete(self, args):
        args = self._args(args, 'contact_delete')
        contact_id = require_id(args, 'contactId', 'contact_delete')
        return self._delete(f'/contacts/{contact_id}')

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(
            createNewIfDuplicateAllowed=BOOL(
                'Whether to create a second contact when the email or phone already belongs to one, instead of '
                'updating the existing contact.'
            ),
            **_CONTACT_WRITE_PROPS,
        ),
        description=(
            'Create a contact, or update the existing one when its email or phone already belongs to a contact. '
            'Returns the contact plus new, which is true when a contact was created rather than updated. Which of '
            'the two happens depends on the sub-account Allow Duplicate Contact setting, so the same request can '
            'behave differently in different sub-accounts, and when an email matches one contact and a phone '
            'matches another only the first is touched. Call contact_duplicate_check first when you need to know '
            'in advance.'
        ),
        output_schema=RECORD_OUTPUT(
            'The contact under contact, trimmed to the fields this node returns, plus new, which is true when a '
            f'contact was created rather than updated. {_CONTACT_CUSTOM_FIELDS_READ}'
        ),
    )
    def contact_upsert(self, args):
        args = self._args(args, 'contact_upsert')
        body = body_from(args, _CONTACT_WRITE_KEYS + ('createNewIfDuplicateAllowed',), tool='contact_upsert')
        body['locationId'] = self._location()
        return self._write('POST', '/contacts/upsert', _upsert_result, body=body)

    @gohighlevel_tool(
        group='contacts',
        input_schema=schema(
            number=STR('Phone number to look for, in E.164 form, for example "+18888888888".'),
            email=STR('Email address to look for.'),
        ),
        description=(
            'Check whether a phone number or email already belongs to a contact, before creating one. Pass at '
            'least one of number or email. Returns found, plus the matching contact when there is one. '
            'GoHighLevel publishes no response schema for this endpoint, so treat found as the reliable part.'
        ),
        output_schema=RECORD_OUTPUT(
            'found is true when the number or email already belongs to a contact, and contact holds that '
            'contact when there is one, trimmed to the fields this node returns.'
        ),
    )
    def contact_duplicate_check(self, args):
        args = self._args(args, 'contact_duplicate_check')
        params = params_from(args, ('number', 'email'))
        _require_any_of(params, ('number', 'email'), 'contact_duplicate_check')
        params['locationId'] = self._location()
        payload = self._call('GET', '/contacts/search/duplicate', params=params)
        contact = _clean_contact(record_of(payload, 'contact'))
        return {'found': bool(contact.get('id')), 'contact': contact}

    @gohighlevel_tool(
        group='contacts',
        input_schema=schema(
            required=['businessId'],
            businessId=STR(
                'Id of the business. It is in the business URL in the GoHighLevel UI. business_list returns '
                'business ids too, but it belongs to the "businesses" tool group, which this node does not '
                'publish unless gohighlevel.toolGroups names it.'
            ),
            query=STR('Free-text search across the contact record.'),
            **PAGING_SKIP_TEXT('contact_list_by_business'),
        ),
        description=(
            'List the contacts assigned to a business. This one pages by offset rather than by cursor: next is '
            'the skip value for the following page, and it is null once a page comes back shorter than the limit '
            'that was asked for.'
        ),
        output_schema=LIST_OUTPUT(
            'Offset for the next page: pass it back as the skip parameter. Null once a page comes back shorter '
            'than the limit asked for, which means there is no next page.',
            items=_CONTACT_ITEMS,
        ),
    )
    def contact_list_by_business(self, args):
        args = self._args(args, 'contact_list_by_business')
        business_id = require_id(args, 'businessId', 'contact_list_by_business')
        params, limit = skip_text_params(args, 'contact_list_by_business')
        params.update(params_from(args, ('query',)))
        params['locationId'] = self._location()
        payload, records = self._fetch('GET', f'/contacts/business/{business_id}', key='contacts', params=params)
        return paginated(
            [_clean_contact(record) for record in records],
            total=_contact_total(payload),
            next_cursor=next_offset(args.get('skip'), limit, len(records)),
            requested_limit=limit,
        )

    # -- tags --------------------------------------------------------------

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(
            required=['contactId', 'tags'],
            contactId=STR('Id of the contact.'),
            tags=ARR('Tag names to add. Names that do not exist yet are created on the sub-account.'),
        ),
        description=(
            'Add tags to a contact. Returns the contact whole tag list, not just the additions. Use this rather '
            'than contact_update, whose tags field would replace every tag the contact already has. A tag name '
            'that does not exist yet is defined on the whole sub-account as a side effect, and '
            'contact_tags_remove takes it off the contact without removing that definition: only '
            'location_tags_delete does. Tagging many contacts with generated names therefore grows the '
            'sub-account tag list permanently, so reuse the names location_tags_list already reports.'
        ),
        output_schema=RECORD_OUTPUT('The contact whole tag list after the change, under tags, not just the additions.'),
    )
    def contact_tags_add(self, args):
        args = self._args(args, 'contact_tags_add')
        contact_id = require_id(args, 'contactId', 'contact_tags_add')
        body = body_from(args, ('tags',))
        return self._write('POST', f'/contacts/{contact_id}/tags', _tag_result, body=body)

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(
            required=['contactId', 'tags'],
            contactId=STR('Id of the contact.'),
            tags=ARR('Tag names to remove.'),
        ),
        description=(
            'Remove tags from a contact. Returns the tags the contact still has. There is no endpoint that lists '
            'a contact tags, so read them from the record contact_get returns. This takes the tag off the contact '
            'only. A name that contact_tags_add defined on the sub-account stays defined afterwards and keeps '
            'showing up in location_tags_list; location_tags_delete is the only tool that removes the definition.'
        ),
        output_schema=RECORD_OUTPUT('The tags the contact still has after the change, under tags.'),
    )
    def contact_tags_remove(self, args):
        args = self._args(args, 'contact_tags_remove')
        contact_id = require_id(args, 'contactId', 'contact_tags_remove')
        body = body_from(args, ('tags',))
        return self._write('DELETE', f'/contacts/{contact_id}/tags', _tag_result, body=body)

    # -- followers ---------------------------------------------------------

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(
            required=['contactId', 'followers'],
            contactId=STR('Id of the contact.'),
            followers=ARR('User ids to add as followers. Get user ids from user_list_by_location.'),
        ),
        description=(
            'Add users as followers of a contact. There is no endpoint that lists a contact followers, so read '
            'the followers array on the record contact_get returns.'
        ),
        output_schema=RECORD_OUTPUT(
            'The contact whole follower list after the change, under followers, plus followersAdded when '
            'GoHighLevel reports which ids it added.'
        ),
    )
    def contact_followers_add(self, args):
        args = self._args(args, 'contact_followers_add')
        contact_id = require_id(args, 'contactId', 'contact_followers_add')
        body = body_from(args, ('followers',))
        return self._write('POST', f'/contacts/{contact_id}/followers', follower_result, body=body)

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(
            required=['contactId', 'followers'],
            contactId=STR('Id of the contact.'),
            followers=ARR('User ids to remove as followers.'),
        ),
        description='Remove followers from a contact, by user id.',
        output_schema=RECORD_OUTPUT(
            'The contact whole follower list after the change, under followers, plus followersRemoved when '
            'GoHighLevel reports which ids it removed.'
        ),
    )
    def contact_followers_remove(self, args):
        args = self._args(args, 'contact_followers_remove')
        contact_id = require_id(args, 'contactId', 'contact_followers_remove')
        body = body_from(args, ('followers',))
        return self._write('DELETE', f'/contacts/{contact_id}/followers', follower_result, body=body)

    # -- workflows ---------------------------------------------------------

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(
            required=['contactId', 'workflowId'],
            contactId=STR('Id of the contact.'),
            workflowId=STR('Id of the workflow.'),
            eventStartTime=STR(
                'When the workflow should first run, as an ISO 8601 timestamp carrying an offset, for example '
                '"2021-06-23T03:30:00+01:00".'
            ),
        ),
        description=(
            'Enrol a contact in a workflow. GoHighLevel has no endpoint that lists workflows or the workflows a '
            'contact is already in, so the workflowId has to come from the workflow URL in the GoHighLevel UI.'
        ),
        output_schema=RECORD_OUTPUT('ok is true when GoHighLevel reported the enrolment as successful.'),
    )
    def contact_workflow_add(self, args):
        args = self._args(args, 'contact_workflow_add')
        contact_id = require_id(args, 'contactId', 'contact_workflow_add')
        workflow_id = require_id(args, 'workflowId', 'contact_workflow_add')
        body = body_from(args, ('eventStartTime',))
        return self._write('POST', f'/contacts/{contact_id}/workflow/{workflow_id}', flag_result, body=body)

    @gohighlevel_tool(
        group='contacts',
        writes=True,
        input_schema=schema(
            required=['contactId', 'workflowId'],
            contactId=STR('Id of the contact.'),
            workflowId=STR('Id of the workflow to remove the contact from.'),
        ),
        description=(
            'Remove a contact from a workflow. GoHighLevel has no endpoint that lists the workflows a contact is '
            'in, so the workflowId has to come from the GoHighLevel UI or from the call that added it.'
        ),
        output_schema=RECORD_OUTPUT('ok is true when GoHighLevel reported the removal as successful.'),
    )
    def contact_workflow_remove(self, args):
        args = self._args(args, 'contact_workflow_remove')
        contact_id = require_id(args, 'contactId', 'contact_workflow_remove')
        workflow_id = require_id(args, 'workflowId', 'contact_workflow_remove')
        # This DELETE declares a required JSON body, so an empty object is sent rather than nothing.
        return self._write('DELETE', f'/contacts/{contact_id}/workflow/{workflow_id}', flag_result, body={})

    # -- related records ---------------------------------------------------

    @gohighlevel_tool(
        group='contacts',
        input_schema=schema(required=['contactId'], contactId=STR('Id of the contact.')),
        description=(
            'List the calendar appointments booked for a contact. Returns appointments under items, and the '
            'whole list comes back in one response, so there is no cursor. Times here are naive local strings '
            'formatted "YYYY-MM-DD HH:mm:ss" with no timezone, while the same appointment read through '
            'appointment_get carries a numeric UTC offset instead, so compare the two with care.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every appointment in one response, so there is no next page.',
            items='The appointments booked for the contact, as GoHighLevel returns them.',
        ),
    )
    def contact_appointments_list(self, args):
        args = self._args(args, 'contact_appointments_list')
        contact_id = require_id(args, 'contactId', 'contact_appointments_list')
        return self._list(f'/contacts/{contact_id}/appointments', key='events', cleaner=passthrough)
