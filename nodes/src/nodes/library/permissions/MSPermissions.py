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

import time
import uuid
from requests.status_codes import codes as status_codes

# ------------------------------------------------------------------------------
#
# Import the engLib module. This is defined within the C++ code and is used
# as a generic bridge between the python and C++ code
#
# ------------------------------------------------------------------------------
import engLib

# ------------------------------------------------------------------------------
#
# PermissionSet describes permissions
#
# ------------------------------------------------------------------------------
from .PermissionSet import PermissionSet

# constants
BATCH_URL = '/v1.0/$batch'  # Batch URL


def is_valid_uuid(uuid_string: str) -> bool:
    """Check if ID represents valid ID.

    Args:
        uuid_string (str): UUID as a string

    Returns:
        bool: True if uuid_string could be converted to UUID, False otherwise
    """
    try:
        uuid.UUID(uuid_string)
        return True
    except ValueError:
        return False


def process_ms_permissions_bulk(
    batch_items: list,
    url_generator_lambda: any,
    add_permissions_lambda: any,
    add_user_info_lambda: any,
    add_group_info_lambda: any,
    fallback_lambda: any,
    request_wrapper: any,
    tenant_id: str,
    check_uuid: bool = True,
    skip_item_lambda: any = None,
    get_wait_time_lambda: any = None,
):
    """Process a batch of items to get their permissions using Microsoft Graph batch API.

    This is a generic function that can be used by different Microsoft services
    (OneDrive, SharePoint, etc.) to process permissions in bulk.

    Args:
        batch_items (list): List of item objects to process in this batch.
        url_generator_lambda (any): Lambda function to generate URL for each item. Should return url.
        add_permissions_lambda (any): Lambda function to add permissions.
                                     Should take permissions and return permission ID.
        add_user_info_lambda (any): Lambda function to add user information.
                                   Should take (id, authority, name, local).
        add_group_info_lambda (any): Lambda function to add group information.
                                    Should take (id, authority, name, local).
        fallback_lambda (any): Lambda function to fall back to individual processing.
                              Should take item_object.
        request_wrapper (any): The request wrapper object to send HTTP requests.
        tenant_id (str): The tenant ID for the Microsoft service.
        check_uuid (bool): Whether to check UUID validity for user/group IDs.
                          It is True for Enterprise accounts, and False for personal accounts.
        skip_item_lambda (any): Optional lambda function to skip item processing.
        get_wait_time_lambda (any): Optional lambda function to calculate wait time on throttling.
                                   Should take (attempt, headers) and return seconds to wait or -1 to fail.
    """
    try:
        # Build batch request body for Microsoft Graph
        batch_requests = []
        item_id_map = {}  # Map to track which item corresponds to which request

        for idx, item_object in enumerate(batch_items):
            # check if item should be skipped
            if skip_item_lambda and skip_item_lambda(item_object):
                engLib.debug(f'Skipping item {item_object.path} based')
                item_object.completionCode(engLib.Ec.Skip, 'Item skipped by skip_item_lambda')
                continue

            # Get the URL for this item using the provided lambda
            url = url_generator_lambda(item_object)
            if not url:
                continue

            # Create batch request for this item
            batch_request = {
                'id': str(idx),
                'method': 'GET',
                'url': url,
                'headers': {'Content-Type': 'application/json'},
            }
            batch_requests.append(batch_request)
            item_id_map[str(idx)] = item_object

        if not batch_requests:
            return

        # Create batch request body && headers
        batch_body = {'requests': batch_requests}
        headers = {
            'Content-Type': 'application/json',
        }

        attempt = 0
        wait_before_return = 0

        while True:
            response = None
            engLib.debug(f'Sending batch request for {len(batch_items)} items (attempt {attempt + 1})')
            try:
                # Send batch request to Microsoft Graph
                response = request_wrapper.send('post', BATCH_URL, headers=headers, data=str(batch_body))

            except Exception as request_err:  # pylint: disable=broad-except
                wait = get_wait_time_lambda(attempt, None)
                if wait == -1:
                    engLib.debug(f'Batch request attempt {attempt + 1} failed with error: {request_err}')
                    raise Exception(f'Batch request attempt {attempt + 1} failed with error: {request_err}')

                engLib.debug(
                    f'Batch request attempt {attempt + 1} failed with error: {request_err}, retrying in a {wait} seconds...'
                )
                time.sleep(wait)
                attempt += 1
                continue

            if response.status_code == status_codes.ok:  # HTTP OK
                engLib.debug(f'Response code for the bulk request is {response.status_code}')
                batch_response = response.json()
                break

            # not OK - calculate wait time
            wait = get_wait_time_lambda(attempt, response.headers)
            if wait == -1:
                engLib.debug(f'Batch request failed after {attempt + 1} attempts (status {response.status_code})')
                raise Exception(f'Batch request failed after {attempt + 1} attempts (status {response.status_code})')

            engLib.debug(
                f'Batch request attempt {attempt + 1} failed with status {response.status_code}, retrying in a {wait} seconds...'
            )
            time.sleep(wait)
            attempt += 1
            continue

        # Process batch response
        if 'responses' in batch_response:
            for resp in batch_response['responses']:
                request_id = resp.get('id')
                status = resp.get('status')
                engLib.debug(f'Response code for the item "{item_object.path}" is {status}')

                if request_id in item_id_map:
                    item_object = item_id_map.pop(request_id)

                    if status == status_codes.ok:  # HTTP OK
                        # Success - process permissions
                        try:
                            json_response = resp.get('body', {})
                            # Process MS permissions using the same logic as individual processing
                            process_ms_permissions(
                                item_object,
                                json_response,
                                tenant_id,
                                add_permissions_lambda,
                                add_user_info_lambda,
                                add_group_info_lambda,
                                check_uuid,
                            )
                        except Exception as perm_err:
                            engLib.debug(f'Failed to process permissions for object "{item_object.path}": {perm_err}')
                            item_object.completionCode(engLib.Ec.Error, str(perm_err))

                    elif status == status_codes.not_found:  # HTTP 404 - not found
                        engLib.debug(f'Object "{item_object.path}" not found')
                        item_object.completionCode(engLib.Ec.NotFound, 'not found')

                    elif status == status_codes.too_many_requests:  # 429 - throttling
                        engLib.debug(
                            f'Object "{item_object.path}" failed with HTTP Too Many Requests (throttling), marking for retry'
                        )
                        wait_before_return = max(
                            1, wait_before_return, get_wait_time_lambda(1, resp.get('headers', {}))
                        )
                        item_object.completionCode(engLib.Ec.Retry, 'Too Many Requests (throttling)')

                    else:  # Other error
                        error_body = resp.get('body', {})
                        error_msg = error_body.get('error', {}).get('message', f'HTTP {status}')
                        engLib.debug(f'Object "{item_object.path}" failed: {error_msg}')
                        item_object.completionCode(engLib.Ec.Retry, error_msg)

        engLib.debug(f'Processed responses for {len(batch_items) - len(item_id_map)} items')
        engLib.debug(f'No response for {len(item_id_map)}, marking them for retry')
        # Mark remaining items (that didn't receive a response) for retry
        for request_id, item_object in item_id_map.items():
            engLib.debug(
                f'process_ms_permissions_bulk: no response received for "{item_object.path}" marking for retry'
            )
            item_object.completionCode(engLib.Ec.Retry, 'no response received from batch request')

        if wait_before_return > 0:
            engLib.debug(f'Per object throttling detected, waiting {wait_before_return} seconds')
            time.sleep(wait_before_return)
    except Exception as err:
        engLib.debug(f'Batch request failed: {err}')
        # Fall back to individual requests for this batch
        for item_object in batch_items:
            try:
                fallback_lambda(item_object)
            except Exception as fallback_err:
                engLib.debug(f'Fallback failed for {item_object.path}: {fallback_err}')
                item_object.completionCode(engLib.Ec.Error, str(fallback_err))


def process_ms_permissions(
    item_object: any,
    json_response: dict,
    tenant_id: str,
    addPermissionsLambda: any,
    addUserInfoLambda: any,
    addGroupInfoLambda: any,
    check_uuid: bool = True,
):
    """Process Microsoft Permissions.

    Args:
        item_object (any): object from the engine
        json_response (dict): microsoft service permissions for the object
        tenant_id (str): tenant Id
        addPermissionsLambda (any): lambda to add permissions
        addUserInfoLambda (any): lambda to add user information
        addGroupInfoLambda (any): lambda to add group information
        check_uuid (bool): indicate that UUID should be checked (it is True for Enterprise accounts, and False for personal accounts)
    """

    # auxilarry function
    def process_sharepoint_identity_set(identity_set: dict):
        """Process SharePointIdentitySet object.

        Args:
            identity_set (dict): SharePointIdentitySet to process (as a dictionary)
        """

        def process_permission_entry(expected_key: str, addFunction: any) -> bool:
            """Process permission entry.

            Args:
                expectedKey (str): key to process
                addFunction (any): function to add permission

            Returns:
                bool: _description_
            """
            if keyV2 == expected_key:
                entry_id = valueV2.get('id', '')  # ID is either empty or non-valid UUID for personal/external accounts
                email = valueV2.get('email', '')
                entry_name = valueV2.get('displayName', '')
                is_uuid = is_valid_uuid(entry_id) if check_uuid and entry_id else False
                if (is_uuid or not check_uuid or not entry_id) and entry_name:
                    entry_id_or_email = entry_id if is_uuid else email
                    addFunction(entry_id_or_email, f'microsoft:{tenant_id}', entry_name, not is_uuid)
                    if is_owner:
                        permissions.set_owner(entry_id_or_email)
                    permissions.add_permissions(entry_id_or_email, rights)
                    return True
            return False

        # process grantedToV2
        for keyV2, valueV2 in identity_set.items():
            # direct reference to AD user/group is present, process it
            # TODO: APPLAT-7680 site group needs to be expanded to the AD user/group
            process_permission_entry('user', addUserInfoLambda)
            process_permission_entry('group', addGroupInfoLambda)
            process_permission_entry('siteUser', addUserInfoLambda)
            process_permission_entry('siteGroup', addGroupInfoLambda)

    engLib.debug(f'Response is: {json_response}')

    permissions = PermissionSet()
    for value in json_response.get('value', {}):
        roles = value.get('roles', [])
        if len(roles) == 0:
            continue
        is_owner = 'owner' in roles
        rights = '+rw' if is_owner or 'write' in roles else '+r'

        # Looks like next needs to be processed:
        #   - grantedToV2
        #   - grantedToIdentitiesV2
        #   - inheritedFrom
        # `inheritedFrom` could be skipped according to the https://learn.microsoft.com/en-us/graph/api/resources/permission?view=graph-rest-1.0
        #       OneDrive for Business and SharePoint document libraries don't return the inheritedFrom property.
        #       grantedTo and grantedToIdentities are deprecated going forward and the response will be migrated
        #       to grantedToV2 and grantedToIdentitiesV2 respectively under appropriate property names.
        engLib.debug(
            f'grantedToV2={len(value.get("grantedToV2", {})) > 0}; grantedToIdentitiesV2={len(value.get("grantedToIdentitiesV2", {})) > 0}; inheritedFrom={len(value.get("inheritedFrom", [])) > 0};'
        )

        # process grantedToV2 - it represents SharePointIdentitySet
        process_sharepoint_identity_set(value.get('grantedToV2', {}))
        # process grantedToIdentitiesV2 - it a list of SharePointIdentitySet
        for identity_set in value.get('grantedToIdentitiesV2', []):
            process_sharepoint_identity_set(identity_set)

    # checks
    if not permissions.get_owner():
        item_object.completionCode('Object has no owner')
        return

    permId = addPermissionsLambda(permissions.get_permissions())
    if permId != -1:
        item_object.permissionId = permId
    else:
        item_object.completionCode('Failed to process permissions')
