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

from nodes.library.sac_requests.wrapper import HttpRequestWrapper


class ApplicationPermissions:
    """Class to check Microsoft Graph application permissions.

    This class contains a dictionary of permissions and a method to check if the given permission is valid.
    """

    # Dictionary of permissions
    # The key is the GUID of the permission, and the value is a dictionary with the following keys:
    # - roleName: The name of the permission.
    # - Display Name: The display name of the permission.
    # - Description: The description of the permission.
    PERMISSIONS = {
        '01d4889c-1287-42c6-ac1f-5d1e02578ef6': {
            'roleName': 'Files.Read.All',
            'Display Name': 'Read files in all site collections',
            'Description': 'Allows the app to read all files in all site collections without a signed in user.',
        },
        '75359482-378d-4052-8f01-80520e7db3cd': {
            'roleName': 'Files.ReadWrite.All',
            'Display Name': 'Read and write files in all site collections',
            'Description': 'Allows the app to read, create, update and delete all files in all site collections without a signed in user.',
        },
        'df021288-bdef-4463-88db-98f22de89214': {'roleName': 'User.Read.All', 'Display Name': "Read all users' full profiles", 'Description': 'Allows the app to read user profiles without a signed in user.'},
        '741f803b-c850-494e-b5df-cde7c675a1ca': {'roleName': 'User.ReadWrite.All', 'Display Name': "Read and write all users' full profiles", 'Description': 'Allows the app to read and update user profiles without a signed in user.'},
        '5b567255-7703-4780-807c-7be8301ae99b': {
            'roleName': 'Group.Read.All',
            'Display Name': 'Read all groups',
            'Description': (
                'Allows the app to create groups, read all group properties and memberships, update group properties '
                'and memberships, and delete groups. Also allows the app to read and write conversations. '
                'All of these operations can be performed by the app without a signed-in user.'
            ),
        },
        '62a82d76-70ea-41e2-9197-370581804d09': {'roleName': 'Group.ReadWrite.All', 'Display Name': 'Read and write all groups', 'Description': 'Allows the app to read and update user profiles without a signed in user.'},
        '332a536c-c7ef-4017-ab91-336970924f0d': {
            'roleName': 'Sites.Read.All',
            'Display Name': 'Read items in all site collections',
            'Description': 'Allows the app to read documents and list items in all site collections without a signed in user.',
        },
        '9492366f-7969-46a4-8d15-ed1a20078fff': {
            'roleName': 'Sites.ReadWrite.All',
            'Display Name': 'Read and write items in all site collections',
            'Description': 'Allows the app to create, read, update, and delete documents and list items in all site collections without a signed in user.',
        },
        'Sites.Manage.All': {
            'id': '0c0bf378-bf22-4481-8f81-9e89a9b4960a',
            'Display Name': 'Create, edit, and delete items and lists in all site collections',
            'Description': 'Allows the app to create or delete document libraries and lists in all site collections without a signed in user.',
        },
        'Sites.FullControl.All': {'id': 'a82116e5-55eb-4c41-a434-62fe8a61c773', 'Display Name': 'Have full control of all site collections', 'Description': 'Allows the app to have full control of all site collections without a signed in user.'},
    }

    @staticmethod
    def check_for_sharepoint(request_wrapper: HttpRequestWrapper, client_id: str, read_only: bool, permissions_scan_enabled: bool) -> tuple:
        """
        Check if the application has the required permisions to work with SharePoint Online.

        This method checks if the application has the required permissions to work with SharePoint Online based on the read_only and permissions_scan_enabled flags.

        :param request_wrapper: The request wrapper object.
        :param client_id: The client ID of the application.
        :param read_only: The read only flag.
        :param permissions_scan_enabled: The permissions scan flag.
        :return: Tuple of (bool, set) indicating if all required permissions are present and the set of missing permissions.
        """
        required_perms = ApplicationPermissions._get_required_permissions_for_sharepoint(read_only, permissions_scan_enabled)
        return ApplicationPermissions._check_required_permissions(request_wrapper, client_id, required_perms)

    @staticmethod
    def check_for_onedrive(request_wrapper: HttpRequestWrapper, client_id: str, read_only: bool, permissions_scan_enabled: bool) -> tuple:
        """
        Check if the application has the required permisions to work with OneDrive.

        This method checks if the application has the required permissions to work with OneDrive based on the read_only and permissions_scan_enabled flags.

        :param request_wrapper: The request wrapper object.
        :param client_id: The client ID of the application.
        :param read_only: The read only flag.
        :param permissions_scan_enabled: The permissions scan flag.
        :return: Tuple of (bool, set) indicating if all required permissions are present and the set of missing permissions.
        """
        required_perms = ApplicationPermissions._get_required_permissions_for_onedrive(read_only, permissions_scan_enabled)
        return ApplicationPermissions._check_required_permissions(request_wrapper, client_id, required_perms)

    @staticmethod
    def _check_required_permissions(request_wrapper: HttpRequestWrapper, client_id: str, required_permissions: dict) -> tuple:
        """
        Check if the given permission is valid.

        :param request_wrapper: The request wrapper object.
        :param client_id: The client ID of the application.
        :param required_permissions: The permission to check.
        :return: Tuple of (bool, set) indicating if all required permissions are present and the set of missing permissions.
        """
        try:
            url = f"/v1.0/servicePrincipals?$filter=appId eq '{client_id}'&$count=true"
            app_info = request_wrapper.send('get', url)
            app_id = app_info.json().get('value', [{}])[0].get('id')
            if not app_id:
                raise ValueError(f'Application with client ID {client_id} not found.')

            url = f'/v1.0/servicePrincipals/{app_id}/appRoleAssignments'
            perms_info = request_wrapper.send('get', url)
            real_permissions = set([ApplicationPermissions.PERMISSIONS.get(perm.get('appRoleId'), {}).get('roleName') for perm in perms_info.json().get('value', []) if perm.get('appRoleId')])
            real_permissions.discard(None)

            # Check if the required permissions are valid
            missing_permissions = set()

            for required_permission_group_name, required_permissions_group in required_permissions.items():
                # for each group of required permissions should be at least one permission
                if not any(perm in real_permissions for perm in required_permissions_group):
                    missing_permissions.add(required_permission_group_name)

            return len(missing_permissions) == 0, missing_permissions
        except Exception as e:
            raise RuntimeError(f'Error checking MS Application Permissions: {e}')

    @staticmethod
    def _get_required_permissions_for_onedrive(read_only: bool = True, permissions_enabled: bool = False) -> dict:
        """
        Get the required application permissions for OneDrive based on the read_only and permissions_enabled flags.

        :param read_only: If True, return read-only permissions.
        :param permissions_enabled: If True, return permissions enabled.
        :return: A dictionary of required permissions for OneDrive.
        """
        result = {}
        if read_only:
            result['Files.Read.All'] = set(['Files.Read.All', 'Files.ReadWrite.All'])
            result['User.Read.All'] = set(['User.Read.All', 'User.ReadWrite.All'])
        else:
            result['Files.ReadWrite.All'] = set(['Files.ReadWrite.All'])
            result['User.ReadWrite.All'] = set(['User.ReadWrite.All'])

        # add permissions
        if permissions_enabled:
            result['Group.Read.All'] = set(['Group.Read.All', 'Group.ReadWrite.All'])
        return result

    @staticmethod
    def _get_required_permissions_for_sharepoint(read_only: bool = True, permissions_enabled: bool = False) -> dict:
        """
        Get the required application permissions for SharePoint Online based on the read_only and permissions_enabled flags.

        :param read_only: If True, return read-only permissions.
        :param permissions_enabled: If True, return permissions enabled.
        :return: A dictionary of required permissions for SharePoint Online.
        """
        result = {}
        if read_only:
            result['Files.Read.All'] = set(['Files.Read.All', 'Files.ReadWrite.All'])
            result['Sites.Read.All'] = set(['Sites.Read.All', 'Sites.ReadWrite.All'])
        else:
            result['Files.ReadWrite.All'] = set(['Files.ReadWrite.All'])
            result['Sites.ReadWrite.All'] = set(['Sites.ReadWrite.All'])

        # add permissions
        if permissions_enabled:
            result['User.Read.All'] = set(['User.Read.All', 'User.ReadWrite.All'])
            result['Group.Read.All'] = set(['Group.Read.All', 'Group.ReadWrite.All'])

        return result
