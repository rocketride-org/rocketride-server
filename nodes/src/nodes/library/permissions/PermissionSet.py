# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

import copy


class PermissionSet:
    """Class to describe permissions."""

    def __init__(self):
        """Init objects."""
        self.permissions = {}
        self.permissions['index'] = 0
        self.permissions['perms'] = []
        self.permissions_aux = {}

    def set_owner(self, owner: str, overwrite: bool = False):
        """Set owner.

        Args:
            owner (str): owner
            overwrite (bool): overwrite if such value doesn't exist
        """
        if self.permissions.get('ownerId', None) is None or overwrite:
            self.permissions['ownerId'] = owner

    def get_owner(self) -> str:
        """Get owner.

        Returns:
            str: owner id
        """
        return self.permissions.get('ownerId')

    def has_owner(self) -> bool:
        """Check if owner is present.

        Returns:
            bool: owner is present
        """
        return self.permissions.get('ownerId') is not None

    def add_permissions(self, principalId: str, rights: str):
        """Add permissions for the corresponding grantee.

        Args:
            principalId (str): principal ID
            rights (str): principals' rights
        """
        self.permissions_aux[principalId] = rights

    def get_permissions(self) -> dict:
        """Return permissions as a dictionary.

        Returns:
            dict: Dictionary
        """
        self.permissions['perms'] = [{'principalId': p, 'rights': r} for p, r in self.permissions_aux.items()]
        return self.permissions

    def copy(self) -> any:
        """Generate a shallow copy of the current object.

        Returns:
            any: shallow copy of the current object
        """
        return copy.copy(self)

    def deepcopy(self) -> any:
        """Generate a deep copy of the current object.

        Returns:
            any: deep copy of the current object
        """
        return copy.deepcopy(self)

    def __copy__(self) -> any:
        """Generate a shallow copy of the current object.

        Returns:
            any: shallow copy of the current object
        """
        new_copy = PermissionSet()
        new_copy.permissions = self.permissions.copy()
        new_copy.permissions_aux = self.permissions_aux.copy()
        return new_copy

    def __deepcopy__(self, memo: dict) -> any:
        """Generate a deep copy of the current object.

        Args:
            memo (dict): dictionary used to keep track of objects that have already been copied,
            preventing infinite recursion for circular references

        Returns:
            any: deep copy of the current object
        """
        new_copy = PermissionSet()
        new_copy.permissions = copy.deepcopy(self.permissions, memo)
        new_copy.permissions_aux = copy.deepcopy(self.permissions_aux, memo)
        return new_copy
