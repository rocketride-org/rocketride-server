# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Document Metadata - Source File and Location Information.

This module provides the DocMetadata class containing detailed information about
where document content came from, its permissions, and its position within the
source file. This metadata helps you understand the context of search results.

Usage:
    # Metadata is automatically included with documents from search results
    for doc in search_results:
        meta = doc.metadata
        print(f"Content from: {meta.parent}")
        print(f"Chunk {meta.chunkId} of document {meta.objectId}")

        if meta.isTable:
            print("This content is from a table")
            print(f"Table ID: {meta.tableId}")

        if meta.isDeleted:
            print("Warning: This document has been deleted")
"""

from typing import Any, Dict
from pydantic import BaseModel, Field, ConfigDict


class DocMetadata(BaseModel):
    """
    Contains information about where a document chunk came from and its properties.

    Every document returned from RocketRide operations includes metadata that tells you
    about the source file, the chunk's position within that file, permissions,
    and whether it's table data or regular text. This helps you understand the
    context of your search results and handle different types of content appropriately.

    Key Information Provided:
    - Source file identification (objectId, parent path)
    - Position within the file (chunkId)
    - Content type (table vs text)
    - Access permissions
    - Deletion status

    Attributes:
        objectId: Unique ID for the source document in RocketRide
        chunkId: Position of this chunk within the document (0, 1, 2, etc.)
        parent: File path or name of the source document
        nodeId: Which RocketRide node/server this came from
        permissionId: Access permission level for this document
        isDeleted: Whether the source document has been deleted
        isTable: Whether this chunk contains table data vs regular text
        tableId: If this is table data, which table within the document

    Example:
        doc = search_results[0]
        meta = doc.metadata

        print(f"Found in file: {meta.parent}")
        print(f"This is chunk #{meta.chunkId}")

        if meta.isTable:
            print(f"Table data from table #{meta.tableId}")
        else:
            print("Regular text content")

        if meta.isDeleted:
            print("Warning: Source file was deleted")
    """

    objectId: str = Field(..., description='Unique identifier for the source document in the RocketRide system.')
    chunkId: int = Field(
        ..., description='Position of this chunk within the source document (0=first chunk, 1=second, etc.).'
    )
    nodeId: str = Field(None, description='Identifier of the RocketRide node/server where this document is stored.')
    parent: str = Field(
        None, description='File path or name of the source document. This is what you would see in a file browser.'
    )
    permissionId: int = Field(
        None, description='Permission level identifier that controls who can access this document.'
    )
    isDeleted: bool = Field(
        None, description='True if the source document has been deleted but is still in search results.'
    )
    isTable: bool = Field(
        None, description='True if this chunk contains structured table data, False for regular text content.'
    )
    tableId: int = Field(
        None, description='If isTable is True, this identifies which table within the document this data came from.'
    )
    signature: str = Field(None, description='Component ID or signature associated with the document processing.')

    model_config = ConfigDict(extra='allow')

    def __init__(self, pInstance: Any = None, **data: Any):
        """
        Flexible constructor supporting optional pipeline instance auto-population.

        Args:
            pInstance: Processing instance exposing `instance.currentObject` and
                       `IEndpoint.endpoint.jobConfig['nodeId']`. Optional.
            **data: Explicit field overrides or direct values when `pInstance` is not given.
        """
        if pInstance is not None:
            # Build defaults from the instance context.
            defaults = {
                'objectId': pInstance.instance.currentObject.objectId,
                'chunkId': 0,
                'nodeId': pInstance.IEndpoint.endpoint.jobConfig['nodeId'],
                'parent': pInstance.instance.currentObject.path,
                'permissionId': pInstance.instance.currentObject.permissionId,
                'signature': pInstance.instance.currentObject.componentId,
                'isDeleted': False,
                'isTable': False,
                'tableId': 0,
            }
            # Merge explicit overrides
            defaults.update(data)
            super().__init__(**defaults)
        else:
            # No instance context; rely solely on provided data.
            super().__init__(**data)

    def toDict(self) -> Dict[str, Any]:
        """
        Convert metadata to a dictionary for serialization or storage.

        Useful when you need to save document information, send over networks,
        or store in databases. Excludes None/null values to keep output clean.

        Returns:
            Dict[str, Any]: Dictionary representation of this metadata

        Example:
            meta_data = metadata.toDict()
            json.dump(meta_data, file)  # Save to JSON
        """
        return self.model_dump(exclude_none=True)

    @staticmethod
    def defaultMetadata(pInstance: Any, **overrides) -> 'DocMetadata':
        """
        Return metadata using the constructor-based defaults, allowing overrides.

        """
        return DocMetadata(pInstance, **overrides)
