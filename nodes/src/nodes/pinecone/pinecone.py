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

# ------------------------------------------------------------------------------
# Interface implementation for the Pinecone store
# ------------------------------------------------------------------------------
# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# Load what we need
from typing import List, Callable, Dict, Any
import sys
from uuid import uuid4

from pinecone.grpc import PineconeGRPC as Pinecone
from pinecone import ServerlessSpec, PodSpec

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config

"""
Note: a 'collection' as we know it is referred to as an index in pinecone
    * There are objects called 'collectons' within the pinecone architecture and can be found here:
    * https://docs.pinecone.io/guides/indexes/pods/understanding-collections

    From this point forward, any function calls dealing with checking existence of a collection or reffering to a
    collection are actually referring to an index. If the pinecone specific 'collection' is used, it will be referred
    to as pinecone_collection
"""


class Store(DocumentStoreBase):
    apikey: str | None = None
    node: str = 'pinecone'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    threshhold_search: float = 0.0
    client = None

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the pinecone vector store. We use our own custom DocumentStoreBase.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')  # name of our pinecone index

        # Strip API key also
        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        self.profile = config.get('mode')  # either pod-based or serverless-dense TODO: talk about sparse indexes
        self.threshold_search = config.get('score', 0.5)

        # check if the similarity matches pinecone configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'euclidean', 'dotproduct']:
            self.similarity = similarity
        else:
            raise Exception('The metric you provided in the config.json does not match required pinecone configurations')

        # Init the store
        self.client = Pinecone(api_key=self.apikey)
        return

    def __del__(self):
        """
        Deinitialize the pinecone client.
        """
        # Deinit everything we did
        self.apikey = None
        self.collection = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'
        self.client = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False

        return self.client.has_index(self.collection)

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create a collection, doesn't return anything.

        It must create a new collection even if one already exists.
        The reason for this is that there are actually three parts to
        an the collection:
            1. The collection itself
            2. The payload schema
            3. A bogus record containing the model/vector size
        If the creation fails somewhere along the way, the base Store class
        will recognize that the collection does not exists (intact anyway)
        and call this function to start setting it up again
        """
        if not self._doesCollectionExist():
            # Spec dependent on user choice of index config
            if self.profile == 'serverless-dense':
                spec = ServerlessSpec(cloud='aws', region='us-east-1')
            else:
                # You can customize this as needed
                spec = PodSpec(
                    environment='us-east1-gcp',  # example
                    pods=1,
                    pod_type='p1.x1',
                )

            # Create the collection
            self.client.create_index(name=self.collection, dimension=vectorSize, metric=self.similarity, spec=spec)

        return True

    def _convertFilter(self, docFilter: DocFilter) -> str:
        """
        Build the generic filter based on required permissions, node, parent, etc.
        """
        # Start with isDeleted to handle none and isDeleted
        finalFilterList = [{'isDeleted': {'$eq': docFilter.isDeleted is not None and docFilter.isDeleted}}]
        # Declare the filters we could be filtering the collection on and how we filter them
        filters = {
            '$eq': {'nodeId': docFilter.nodeId, 'isTable': docFilter.isTable, 'parent': docFilter.parent},
            '$in': {'tableId': docFilter.tableIds, 'permissionId': docFilter.permissions, 'objectId': docFilter.objectIds, 'chunkId': docFilter.chunkIds},
            '$gte': {'chunkId': docFilter.minChunkId},
            '$lte': {'chunkId': docFilter.maxChunkId},
        }

        # Looping through filter types to get all filter attributes that are not None
        for filter_type in filters:
            for doc_filter_attribute in filters[filter_type]:
                if filters[filter_type][doc_filter_attribute] is not None:
                    finalFilterList.append({doc_filter_attribute: {filter_type: filters[filter_type][doc_filter_attribute]}})

        # Return full filter
        return {'$and': finalFilterList}

    def _convertToDocs(self, points: List[dict]) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        Groups all document chunks  together
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            # Get the point's content and meadata
            metadata = DocMetadata(**point['metadata'])
            content = point['metadata']['content']

            # Determine the score of this document
            score = point['score']

            # Create asearc new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            # Append it to this documents chunks
            docs.append(doc)

        # Return it
        return docs

    def count_documents(self) -> int:
        """
        Return the number of vectors in the document store, not the number of documents themselves.

        Returns how many documents are present in the document store.
        """
        # If the collection does not exists, by definition there are
        # no documents in the collection
        if not self.doesCollectionExist():
            return 0

        index = self.client.Index(self.collection)
        return int(index.describe_index_stats()['total_vector_count'])

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filter
        filter = self._convertFilter(docFilter)

        # Adding keyword search to filters
        filter['$and'].append({'content': {'$contains': query.text}})

        # Convert the points into groups
        docs = self.get(filter)

        # Return them
        return docs

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filter
        filter = self._convertFilter(docFilter)

        # We know the collection exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Getting index
        index = self.client.Index(self.collection)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise BaseException('Non-zero offset is not supported in semantic searching')

        # Perform the search
        points = index.query(
            vector=query.embedding,
            top_k=docFilter.limit if docFilter.limit is not None else 25,
            filter=filter,
            include_metadata=True,
            include_values=False,
        )['matches']

        # Have to get similarity score threshold post query
        points_satisfy_threshold = [point for point in points if point['score'] >= self.threshhold_search]
        # Convert the points into groups
        docs = self._convertToDocs(points_satisfy_threshold)

        # Return them
        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Given a filter, return the document groups matching the filter.
        """
        # If the collection does not exists, by definition there are
        # no documents matching the get
        if checkCollection and not self.doesCollectionExist():
            return []

        # Build up the filter
        filter = self._convertFilter(docFilter=docFilter)

        # Getting index
        index = self.client.Index(self.collection)
        vector_size = int(index.describe_index_stats()['dimension'])

        # Perform the search
        records = index.query(vector=[1] * vector_size, top_k=10000, filter=filter, include_metadata=True, include_values=False)['matches']

        # Convert the points into documents
        docs = self._convertToDocs(records)
        return docs

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Query and return all the unique parent paths.
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        # Build up the filter for chunkId = 0
        filterList = [{'chunkId': {'$eq': 0}}]

        # If parent specified, add it to the filter
        if parent is not None:
            filterList.append({'parent': {'$eq': parent}})

        # Build the full filter
        filter = {'$and': filterList}

        # Getting index
        index = self.client.Index(self.collection)
        vector_size = int(index.describe_index_stats()['dimension'])

        # Pinecone doesn't support offset directly, so we need to query with a larger top_k
        # and handle pagination manually. We'll query for offset + limit results and slice
        top_k = offset + limit if limit > 0 else 10000

        # Perform the query
        records = index.query(
            vector=[1] * vector_size,
            top_k=top_k,
            filter=filter,
            include_metadata=True,
            include_values=False,
        )['matches']

        # Apply offset and limit manually
        paginated_records = records[offset : offset + limit] if limit > 0 else records[offset:]

        # Build up the path list
        paths: Dict[str, str] = {}

        # Fill it in
        for record in paginated_records:
            # Get the metadata
            metadata_dict = record.get('metadata')
            if metadata_dict is None:
                continue

            # Convert to DocMetadata to access fields
            metadata = DocMetadata(**metadata_dict)

            # Get the parent and objectId
            parent_path = metadata.parent
            object_id = metadata.objectId

            # Add it to the paths dict
            if parent_path is not None:
                paths[parent_path] = object_id

        # And return what we found
        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the document store.

        (currently doing it chunk by chunk but will upgrade to batch additions with payload limits like others)
        """
        # If no documents present, get out
        if not len(chunks):
            return

        # Create the collection if needed
        if checkCollection and not self.createCollection(chunks):
            return

        points_to_upsert = []

        # Clear the object id list
        objectIds: Dict = {}

        def flush():
            nonlocal points_to_upsert
            nonlocal objectIds

            # Getting index
            index = self.client.Index(self.collection)

            # Batch operation for deletion
            if len(objectIds):
                self.remove(list(objectIds.keys()))

            # Batch operation for upsert
            if len(points_to_upsert):
                index.upsert(vectors=points_to_upsert)

            # Clear them
            objectIds = {}
            points_to_upsert = []

        # For each document set objectId to true to make sure we delete any chunks we already have added
        for chunk in chunks:
            if chunk.metadata.objectId != 'schema':
                objectIds[chunk.metadata.objectId] = True

        sum_size = 0
        cur_size = 0
        # For each document
        for chunk in chunks:
            # Get the embedding
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            metadata = dict(chunk.metadata)
            metadata['content'] = chunk.page_content

            # Bogus document which is not compatible with pinecone because it can't accept all zeroes
            if chunk.metadata.objectId == 'schema':
                embedding[-1] = 1
                metadata['nodeId'] = ''
                metadata['parent'] = ''
                metadata['permissionId'] = 0
                metadata['isTable'] = False
                metadata['tableId'] = 0

            # Append the points // create a unique identifier that fits into an int64 id field
            vector_struct = {
                'id': str(uuid4()),
                'values': embedding,
                'metadata': metadata,
            }

            cur_size = sys.getsizeof(vector_struct)
            sum_size += cur_size
            points_to_upsert.append(vector_struct)

            # Pinecone maxes out at 100 for bulk upsert but chose 50 to ensure it doesn't hit the limit
            if (len(points_to_upsert) >= 50) or (sum_size + cur_size > self.payload_limit):
                flush()
                cur_size = 0
                sum_size = 0

        flush()

    def updateRecords(self, objectIds: List[str], metadataUpdates: Dict[str, Any] = None, isDeleteOperation: bool = False) -> None:
        """
        Collect the ids of records in a list of objectIds to update or delete the records.
        """
        # By definition, if the collection does not exists, there
        # is nothing to update
        if not self.doesCollectionExist():
            return

        # Getting index
        index = self.client.Index(self.collection)
        vector_size = int(index.describe_index_stats()['dimension'])

        records = index.query(vector=[1] * vector_size, top_k=len(objectIds), filter={'objectId': {'$in': objectIds}}, include_metadata=False, include_values=False)['matches']
        ids_to_update = [record['id'] for record in records]

        # Deleting if we need to fully remove documents
        if ids_to_update and isDeleteOperation:
            index.delete(ids_to_update)
            return

        # Updating the metadata fields we want changed for the batch update
        for id_to_update in ids_to_update:
            index.update(id=id_to_update, set_metadata=metadataUpdates)
        return

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        self.updateRecords(objectIds, isDeleteOperation=True)
        return

    def markDeleted(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True
        """
        self.updateRecords(objectIds, {'isDeleted': True})
        return

    def markActive(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted
        """
        self.updateRecords(objectIds, {'isDeleted': False})
        return

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Render the complete document.

        Rehydrates all the chunks into the proper order.
        """
        # By definition, if the collection does not exists, there
        # is nothing to render
        if not self.doesCollectionExist():
            return

        # Since chunks are returned in any order, and a single objectId
        # may contain tens of thousands of chunks, we grave them one
        # group at a time (renderChunkSize), put them into an array,
        # join them and call the callback
        offset = 0
        while True:
            # Building the docFilter to grab chunks matching the objectId and within current chunkId renderSize range
            chunk_range_objectId_filter = DocFilter()
            chunk_range_objectId_filter.objectIds = [objectId]
            chunk_range_objectId_filter.minChunkId = offset
            chunk_range_objectId_filter.maxChunkId = offset + self.renderChunkSize

            # Perform the query
            chunks_in_range = self.get(chunk_range_objectId_filter)

            # Create a renderChunkSize array with empty
            # entries. This will allow us to join even when
            # a chunk doesn't come back
            text: List[str] = [''] * self.renderChunkSize
            lastIndex = -1

            # Now, add the documents to the results
            for chunk in chunks_in_range:
                # Get the info
                # Get the point's content and meadata
                metadata = chunk.metadata
                content = chunk.page_content

                # Should never happen since we gave it an offset
                if metadata.chunkId < offset or metadata.chunkId >= offset + self.renderChunkSize:
                    continue

                # Get the index into the array
                chunk_offset_index = metadata.chunkId - offset

                # Add it to our array
                text[chunk_offset_index] = content

                # Determine the highest index we use
                if chunk_offset_index > lastIndex:
                    lastIndex = chunk_offset_index

            # Compute the number of items we are going to process
            numberOfItems = lastIndex + 1

            # If we got no items back, we are done
            if numberOfItems < 1:
                break

            # Join it together
            fullText = ''.join(text[0:numberOfItems])

            # Call the output function
            callback(fullText)

            # If we got less than we asked for, must be done
            if numberOfItems < self.renderChunkSize:
                break

            offset += self.renderChunkSize
