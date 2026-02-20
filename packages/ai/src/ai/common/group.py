"""
Puts an array of documents into groups and ranks them accordingly.
"""

from typing import List, Dict

from .schema import Doc, DocGroup, DocFilter
from .rerank import ReRank


def getDocumentGroups(query: str, docs: List[Doc], docFilter: DocFilter) -> List[DocGroup]:
    """
    Convert a list of docs to a docGroup.

    Groups all document chunks  together
    """
    groups: List[DocGroup] = []

    # Now, add the documents to the results
    groupDocs: Dict[str, DocGroup] = {}
    for doc in docs:
        # Get the payload content and meadata
        meta = doc.metadata

        # Get the object id of this document
        objectId = meta.objectId

        # Add it to the groupDocs if it isn't there
        if objectId not in groupDocs:
            # Create a new search group for this document
            groupDocs[objectId] = DocGroup(score=0, objectId=objectId, parent=meta.parent)

        # Append it to this documents chunks
        groupDocs[objectId].documents.append(doc)

    # Convert it into an array
    for key in groupDocs:
        groups.append(groupDocs[key])

    if docFilter.useGroupRank and query:
        groups = ReRank.rerankGroups(query, groups)

    # Return it
    return groups
