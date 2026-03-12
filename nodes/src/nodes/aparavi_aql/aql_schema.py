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
Fixed schema for the Aparavi STORE table.

Derived from:
  C:/Projects/aparavi/app/server/server/services/parse/public/columns.ts

Provides two representations:
  - get_schema_dict()       Structured dict for the get_schema tool response
  - get_schema_prompt_text() Compact text block for injection into LLM prompts
"""

from __future__ import annotations

from typing import Any, Dict, List

# ---------------------------------------------------------------------------
# Column definitions — canonical source of truth
# Each entry: name, type (STRING | NUMBER | DATE | OBJECT), description
# ---------------------------------------------------------------------------
COLUMNS: List[Dict[str, Any]] = [
    # Default / most-used columns (ordered first for relevance)
    {'name': 'parentPath',              'type': 'STRING',  'description': 'Path to the corresponding directory of a file'},
    {'name': 'name',                    'type': 'STRING',  'description': 'Name of file or directory'},
    {'name': 'classId',                 'type': 'STRING',  'description': 'Type of node: idxcontainer=directory, idxobject=file, etc'},
    {'name': 'size',                    'type': 'NUMBER',  'description': 'Size of the file on the local file system'},
    {'name': 'storeSize',               'type': 'NUMBER',  'description': 'Size of the file as stored by the database in bytes'},
    {'name': 'modifyTime',              'type': 'DATE',    'description': 'Date file was last modified on the local file system (since Unix epoch in seconds)'},
    {'name': 'createTime',              'type': 'DATE',    'description': 'Date file was first created on the local file system (since Unix epoch in seconds)'},
    {'name': 'accessTime',              'type': 'DATE',    'description': 'Date file was last accessed on the local file system (since Unix epoch in seconds)'},

    # Identity
    {'name': 'uniqueId',                'type': 'STRING',  'description': 'Unique external ID provided by the source service'},
    {'name': 'uniqueName',              'type': 'STRING',  'description': 'Unique name inside its parent directory'},
    {'name': 'objectId',                'type': 'STRING',  'description': 'Internal object ID'},
    {'name': 'parentId',                'type': 'STRING',  'description': 'Parent object ID'},
    {'name': 'instanceId',              'type': 'NUMBER',  'description': 'Instance ID of the file'},
    {'name': 'nodeObjectId',            'type': 'STRING',  'description': 'ID of the returned node'},
    {'name': 'componentId',             'type': 'STRING',  'description': 'Component ID as text'},
    {'name': 'dupKey',                  'type': 'STRING',  'description': 'Cryptographic file signature representing unique content'},

    # File attributes
    {'name': 'extension',               'type': 'STRING',  'description': 'File extension (without dot)'},
    {'name': 'category',                'type': 'STRING',  'description': 'Category for which the file extension belongs'},
    {'name': 'mimeType',                'type': 'STRING',  'description': 'File MIME type'},
    {'name': 'version',                 'type': 'NUMBER',  'description': 'Number of times a file has changed; each number is a new version'},
    {'name': 'attrib',                  'type': 'NUMBER',  'description': 'Number of attributes associated with the file'},
    {'name': 'flags',                   'type': 'NUMBER',  'description': 'Object flags indicating status of file'},
    {'name': 'iFlags',                  'type': 'NUMBER',  'description': 'Instance flags indicating current status of file'},

    # Document metadata
    {'name': 'metadata',                'type': 'STRING',  'description': 'Document internal information (creator, original dates, etc.)'},
    {'name': 'metadataObject',          'type': 'OBJECT',  'description': 'Document internal information as JSON object'},
    {'name': 'docModifyTime',           'type': 'DATE',    'description': 'Date the document was last modified'},
    {'name': 'docCreateTime',           'type': 'DATE',    'description': 'Date the document was created'},
    {'name': 'docModifier',             'type': 'STRING',  'description': 'User by whom the document was last modified'},
    {'name': 'docCreator',              'type': 'STRING',  'description': 'User by whom the document was created'},

    # Email metadata
    {'name': 'metadataEmailTo',         'type': 'STRING',  'description': 'Email recipient(s) from metadata'},
    {'name': 'metadataEmailFrom',       'type': 'STRING',  'description': 'Email sender from metadata'},
    {'name': 'metadataEmailCc',         'type': 'STRING',  'description': 'Email CC recipients from metadata'},
    {'name': 'metadataEmailFromEmail',  'type': 'STRING',  'description': 'Email sender email address from metadata'},
    {'name': 'metadataEmailFromName',   'type': 'STRING',  'description': 'Email sender name from metadata'},
    {'name': 'metadataEmailHasAttachments', 'type': 'STRING', 'description': 'Indicates if email has attachments based on multipart subtype'},

    # Cost / storage metrics
    {'name': 'storageCost',             'type': 'NUMBER',  'description': 'Cost of maintaining a file in storage for up to 30 days'},
    {'name': 'retrievalCost',           'type': 'NUMBER',  'description': 'Cost for retrieving a file'},
    {'name': 'retrievalTime',           'type': 'NUMBER',  'description': 'Estimated time for retrieving a file'},
    {'name': 'compressionRatio',        'type': 'NUMBER',  'description': 'Ratio of stored size to actual file size (percent)'},
    {'name': 'dupCount',                'type': 'NUMBER',  'description': 'Number of identical copies of a file in the database'},
    {'name': 'dri',                     'type': 'NUMBER',  'description': 'Data Readiness Index of the file'},

    # Paths
    {'name': 'path',                    'type': 'STRING',  'description': 'Full path to the file'},
    {'name': 'localPath',               'type': 'STRING',  'description': 'Local path of the file'},
    {'name': 'localParentPath',         'type': 'STRING',  'description': 'Path to file on local disk'},
    {'name': 'winPath',                 'type': 'STRING',  'description': 'Windows absolute path of file'},
    {'name': 'winParentPath',           'type': 'STRING',  'description': 'Windows parent path of file'},
    {'name': 'winLocalPath',            'type': 'STRING',  'description': 'Windows local path of file'},
    {'name': 'winLocalParentPath',      'type': 'STRING',  'description': 'Windows local parent path of file'},
    {'name': 'winNativePath',           'type': 'STRING',  'description': 'Windows Local and SMB Paths combined'},
    {'name': 'linNativePath',           'type': 'STRING',  'description': 'Linux Local and SMB Paths combined'},

    # Service
    {'name': 'serviceId',               'type': 'NUMBER',  'description': 'Target or source unique identifier'},
    {'name': 'service',                 'type': 'STRING',  'description': 'Name of the target or source service'},
    {'name': 'serviceType',             'type': 'STRING',  'description': 'Type of service (target or source)'},
    {'name': 'serviceMode',             'type': 'STRING',  'description': 'Source or Target'},

    # Tags
    {'name': 'tags',                    'type': 'OBJECT',  'description': 'Object tags as a collection (processed by backend)'},
    {'name': 'tagString',               'type': 'STRING',  'description': 'Object tags as a single line of text'},
    {'name': 'tagSetId',                'type': 'NUMBER',  'description': 'Tag set ID'},
    {'name': 'instanceTags',            'type': 'OBJECT',  'description': 'Instance tags as a collection'},
    {'name': 'instanceTagString',       'type': 'STRING',  'description': 'Instance tags as text'},
    {'name': 'userTag',                 'type': 'STRING',  'description': 'Single user tag associated with file'},
    {'name': 'userTags',                'type': 'STRING',  'description': 'Set of user tags for the file'},
    {'name': 'userTagObjects',          'type': 'OBJECT',  'description': 'User tags as objects (processed by backend)'},

    # Dataset
    {'name': 'datasetId',               'type': 'NUMBER',  'description': 'ID of the dataset'},
    {'name': 'dataset',                 'type': 'STRING',  'description': 'Name of the dataset'},
    {'name': 'batchId',                 'type': 'NUMBER',  'description': 'Batch ID of the batch the files belonged to when processed'},
    {'name': 'instanceBatchId',         'type': 'NUMBER',  'description': 'Instance batch ID'},
    {'name': 'wordBatchId',             'type': 'NUMBER',  'description': 'Batch ID containing the words in the file'},
    {'name': 'vectorBatchId',           'type': 'NUMBER',  'description': 'Batch ID containing the vectors in the file'},

    # Classification
    {'name': 'classificationId',        'type': 'NUMBER',  'description': 'ID number associated with a classification'},
    {'name': 'classification',          'type': 'STRING',  'description': 'Name of the classification applied to the file'},
    {'name': 'confidence',              'type': 'NUMBER',  'description': 'Confidence level of a classification hit (0-1)'},
    {'name': 'classifications',         'type': 'STRING',  'description': 'Semicolon-separated list of all classifications for the file'},
    {'name': 'classificationObjects',   'type': 'OBJECT',  'description': 'Classification set as objects (processed by backend)'},

    # Ownership & permissions
    {'name': 'osOwner',                 'type': 'STRING',  'description': 'Owner of the file'},
    {'name': 'osOwnerObject',           'type': 'OBJECT',  'description': 'OS owner details (processed by backend)'},
    {'name': 'osPermission',            'type': 'STRING',  'description': "A file's Operating System permission"},
    {'name': 'osPermissions',           'type': 'STRING',  'description': 'All OS permissions associated with the file'},
    {'name': 'osPermissionObjects',     'type': 'OBJECT',  'description': 'OS permissions as objects (processed by backend)'},

    # Audit messages
    {'name': 'instanceMessage',         'type': 'STRING',  'description': 'Audit message of action(s) taken on an instance'},
    {'name': 'instanceMessageTime',     'type': 'DATE',    'description': 'Time an action was taken on an instance'},
    {'name': 'instanceMessageObjects',  'type': 'OBJECT',  'description': 'Audit message with associated transaction (processed by backend)'},
    {'name': 'objectMessage',           'type': 'STRING',  'description': 'Message associated with the file'},
    {'name': 'objectMessageTime',       'type': 'DATE',    'description': 'Time when the file message was sent'},
    {'name': 'objectMessageObjects',    'type': 'OBJECT',  'description': 'File message as objects (processed by backend)'},

    # Search hits
    {'name': 'searchHit',               'type': 'STRING',  'description': 'Search term that was found'},
    {'name': 'searchHitWordsBefore',    'type': 'STRING',  'description': 'Words leading up to the search hit'},
    {'name': 'searchHitWordsAfter',     'type': 'STRING',  'description': 'Words trailing the search hit'},
    {'name': 'searchHits',              'type': 'OBJECT',  'description': 'Full search hit context (use with WHICH CONTAIN clause)'},

    # Classification hits
    {'name': 'classificationHit',           'type': 'STRING',  'description': 'Content detected as a classification hit'},
    {'name': 'classificationHitPolicy',     'type': 'STRING',  'description': 'Policy of the classification hit'},
    {'name': 'classificationHitRule',       'type': 'STRING',  'description': 'Rules of the classification associated with the file'},
    {'name': 'classificationHitConfidence', 'type': 'NUMBER',  'description': 'Confidence threshold required for classification'},
    {'name': 'classificationHitWordsBefore', 'type': 'STRING', 'description': 'Words leading up to the classification hit'},
    {'name': 'classificationHitWordsAfter',  'type': 'STRING', 'description': 'Words trailing the classification hit'},
    {'name': 'classificationHits',          'type': 'OBJECT',  'description': 'Full classification hit context'},

    # Status flags (stored as NUMBER: 0 or 1)
    {'name': 'isContainer',             'type': 'NUMBER',  'description': '1 if this item is a directory/container, 0 otherwise'},
    {'name': 'isDeleted',               'type': 'NUMBER',  'description': '1 if the data has been removed, 0 otherwise'},
    {'name': 'isObject',                'type': 'NUMBER',  'description': '1 if this item is a file/object, 0 otherwise'},
    {'name': 'isSigned',                'type': 'NUMBER',  'description': '1 if a cryptographic signature has been applied to the file'},
    {'name': 'isIndexed',               'type': 'NUMBER',  'description': '1 if the file is indexed'},
    {'name': 'isClassified',            'type': 'NUMBER',  'description': '1 if the file is classified'},

    # Virtual
    {'name': 'node',                    'type': 'STRING',  'description': 'Virtual column: name of the aggregator or collector node'},
    {'name': 'processPipe',             'type': 'STRING',  'description': 'Process pipe ID of the file'},
]


def get_schema_dict() -> Dict[str, Any]:
    """Return the structured schema dict for the get_schema tool response."""
    return {'store': 'STORE', 'columns': COLUMNS}


def get_schema_prompt_text() -> str:
    """Return a compact column listing for injection into LLM prompts."""
    lines = [
        'Table: STORE',
        'Columns:',
    ]
    for col in COLUMNS:
        lines.append(f"  {col['name']} ({col['type']}) — {col['description']}")
    return '\n'.join(lines)
