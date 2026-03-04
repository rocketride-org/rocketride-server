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

from typing import Any, Callable, Dict


class FolderTracker:
    """Track folders according to engine requirements.

    Engine waits for items in DFS-like order, e.g. folder and all its items (recursively).
    Microsoft Graph API returns item in unspecified order.
    The only specified order is by time, which doesn't satisfy engine requirements:
    https://learn.microsoft.com/en-us/graph/delta-query-messages#use-query-parameters-in-a-delta-query-for-messages.

    This class could be used with other nodes, it works as a preprocessor to existing engine functionality.

    Memory usage:
        Class keeps records of all folder in memory.

    Error checking and assumptions:
        Class assume that any child folder appears AFTER its parent folder. If it is not the true behaviour is undefined.
        No error checking is done - class assumes that all data is consistent.

    TODO: Note: The best solution is to refactor the engine to get rid of this requirement, however it is more complicated,
    and would result in thorogh testing of all available node, not only this one.
    """

    def __init__(self) -> None:
        """Initialize the FolderTracker."""
        self._folders = {}
        self._current_folder = None
        self._scan_callback = None

    def set_scan_callback(self, scan_callback: Callable[[Dict[str, Any]], None]) -> None:
        """Set callback function to be called.

        Args:
            scan_callback (Callable[[Dict[str, Any]], None]): Callback function that is going to be called
        """
        self._scan_callback = scan_callback

    def scan_callback(self, item: dict) -> None:
        """Process callback for item scanning.

        Args:
            item (dict): Item to be processed

        Raises:
            KeyboardInterrupt: Exception that is raised when scan is interrupted
        """
        parent_folders = self._preprocess_item(item)
        if parent_folders:
            for folder in parent_folders:
                self._scan_callback(folder)
        res = self._scan_callback(item)
        if res:
            raise KeyboardInterrupt(f'Scan interrupted by callback:\n\titem {item},\n\tresult: {res}')

    def _preprocess_item(self, item: dict) -> list:
        """Preprocess item. Check if the item is inside current directory tree.

        Args:
            item (dict): Item to be added.

        Returns:
            list: List of folders that should be added before adding the item. List may be empty if item is added in the same location
            with the previous item.
        """
        # root -> reset
        if 'rootUniqueName' in item:
            return self._reset(item)

        # child of the current parent folder
        if item.get('parentUniqueName') == self._current_folder['uniqueName']:
            self._set_current_folder(item)
            return None

        # not child of the current parent folder - construct list
        path_to_item = self._construct_path(item)
        path_to_current_item = self._construct_path(self._current_folder)

        # process it if is a containr
        self._set_current_folder(item)

        # remove common prefix
        return self._remove_common_elements(path_to_item, path_to_current_item)

    def _reset(self, item: dict) -> list:
        """Reset the class when root item is detected.

        Args:
            item (dict): root item

        Returns:
            list: always empty list
        """
        self._folders = {item['uniqueName']: item}
        self._current_folder = item
        return []

    def _set_current_folder(self, item: dict) -> None:
        """Take item and set current folder.

        Args:
            item (dict): Item to set current folder for.
        """
        if item['isContainer']:
            self._folders[item['uniqueName']] = item
            self._current_folder = item
        else:
            self._current_folder = self._folders[item['parentUniqueName']]

    def _construct_path(self, item: dict) -> list:
        """Construct path to the item, from top to bottom.

        Args:
            item (dict): Item to construct path for.

        Returns:
            list: Path for the current item.
        """
        # not child of the current parent folder - construct list
        folder_list: list = []
        current_item = item
        while current_item.get('parentUniqueName'):
            current_item = self._folders[current_item['parentUniqueName']]
            folder_list.append(current_item)

        #  reverse order, from top to down
        folder_list.reverse()

        return folder_list

    def _remove_common_elements(self, path_to_new_item: list, path_to_current_item: list) -> list:
        """Truncate the common prefix of two lists.

        Args:
            path_to_new_item (list): list which points to the new item
            path_to_current_item (list): list which points to the current item

        Returns:
            list: list which points to the new item, but doesn't have common elements with the list that points to current item
        """
        min_len = min(len(path_to_new_item), len(path_to_current_item))

        # Find the first index where elements differ
        split_index = 0
        for i in range(min_len):
            if path_to_new_item[i] != path_to_current_item[i]:
                break
            split_index += 1

        # Truncate the lists up to the split index
        return path_to_new_item[split_index:]
