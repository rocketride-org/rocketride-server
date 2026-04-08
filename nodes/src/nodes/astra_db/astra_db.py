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

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import List, Callable, Dict, Any
from uuid import uuid4
import re

from astrapy import DataAPIClient, Database
from astrapy.data_types import DataAPIVector
from astrapy.info import CollectionDefinition, CollectionVectorOptions, CollectionLexicalOptions

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config

from rocketlib import warning


class Store(DocumentStoreBase):
    application_token: str | None = None
    node: str = 'astra_db'
    collection_name: str = ''
    api_endpoint: str = ''
    similarity: str = 'cosine'
    client: DataAPIClient | None = None
    database: Database | None = None

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the astradb vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection_name = config.get('collection', '')

        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9_]*$', self.collection_name):
            raise Exception(f'Invalid collection name: {self.collection_name}')

        # Remove leading and trailing spaces, leading http/https and :// and trailing slashes
        self.api_endpoint = config.get('api_endpoint')

        # check if the similarity matches astra configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'euclidean', 'dot_product']:
            self.similarity = similarity
        else:
            raise Exception('The similarity metric you provided in the config.json does not match required astra configurations')

        # Strip API key also
        self.application_token = config.get('application_token', None)
        if self.application_token is not None:
            self.application_token = self.application_token.strip()

        # Init the store
        self.client = DataAPIClient()
        self.database = self.client.get_database(self.api_endpoint, token=self.application_token)
        return

    def __del__(self):
        """
        Deinitializes the AstraDB client.
        """
        # Deinit everything we did
        self.application_token = None
        self.api_endpoint = ''
        self.client = None
        self.database = None
        return

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.database is None:
            return False
        return self.collection_name in self.database.list_collection_names()

    def doesCollectionExist(self, modelName: str = None) -> bool:
        """
        Override base class to handle AstraDB-specific collection validation.

        Returns False if collection doesn't exist or doesn't have control document,
        allowing base class to create it properly.
        """
        try:
            return super().doesCollectionExist(modelName)
        except Exception:
            # If validation fails (e.g., no control document), return False
            # so base class will attempt to create/fix the collection
            return False

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create a collection with proper vector configuration.

        The base class will handle creating the control document separately.
        """
        try:
            # Define collection with custom embedding support
            collection_definition = CollectionDefinition(vector=CollectionVectorOptions(dimension=vectorSize, metric=self.similarity), lexical=CollectionLexicalOptions(enabled=True, analyzer='standard'))

            # Create the collection
            self.database.create_collection(name=self.collection_name, definition=collection_definition)

            return True

        except Exception as e:
            warning(f'Collection creation failed: {e}')
            return False

    def _convertFilter(self, docFilter: DocFilter) -> Dict:
        """
        Build the generic filter based on required permissions, node, parent, etc.

        Convert DocFilter to AstraDB query format.
        """
        filter_dict = {}

        # If a nodeId was specified
        if docFilter.nodeId is not None:
            filter_dict['meta.nodeId'] = docFilter.nodeId

        if docFilter.isTable is not None:
            filter_dict['meta.isTable'] = docFilter.isTable

        if docFilter.tableIds is not None:
            filter_dict['meta.tableId'] = {'$in': docFilter.tableIds}

        # If a parent was specified
        if docFilter.parent is not None:
            filter_dict['meta.parent'] = {'$regex': docFilter.parent}

        # If a permissionId list was specified
        if docFilter.permissions is not None:
            filter_dict['meta.permissionId'] = {'$in': docFilter.permissions}

        # If a objectIds list was specified
        if docFilter.objectIds is not None:
            filter_dict['meta.objectId'] = {'$in': docFilter.objectIds}

        # Match other document stores (Qdrant, Postgres, Elasticsearch): default
        # queries must not return soft-deleted rows. When isDeleted is True, omit this
        # clause so callers can include deleted documents in the result set.
        if docFilter.isDeleted is None or not docFilter.isDeleted:
            filter_dict['meta.isDeleted'] = False

        # If we are going after specific chunks
        if docFilter.chunkIds is not None:
            filter_dict['meta.chunkId'] = {'$in': docFilter.chunkIds}

        # If we have min chunk id
        if docFilter.minChunkId is not None:
            if 'meta.chunkId' not in filter_dict:
                filter_dict['meta.chunkId'] = {}
            filter_dict['meta.chunkId']['$gte'] = docFilter.minChunkId

        # If we have max chunk id
        if docFilter.maxChunkId is not None:
            if 'meta.chunkId' not in filter_dict:
                filter_dict['meta.chunkId'] = {}
            filter_dict['meta.chunkId']['$lte'] = docFilter.maxChunkId

        return filter_dict

    def _convertToDocs(self, documents: List[Dict]) -> List[Doc]:
        """
        Convert a list of AstraDB documents to Doc objects.
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for document in documents:
            # Check for required fields - updated field name
            if 'content' not in document or 'meta' not in document:
                continue

            # Get the content and metadata - updated field name
            metadata = DocMetadata(**document['meta'])
            content = document['content']

            # Determine the score of this document
            if '$similarity' in document:
                score = document['$similarity']
                # Ignore if score too low
                if score < 0.20:
                    continue
            else:
                score = 0

            # Create a new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            # Append it to this documents chunks
            docs.append(doc)

        # Return it
        return docs

    def count_documents(self) -> int:
        """
        Return the number of documents in the document store.
        """
        # If the collection does not exist, by definition there are
        # no documents in the collection
        if not self._doesCollectionExist():
            return 0

        # Get the collection
        collection = self.database.get_collection(self.collection_name)

        # Return the document count
        return collection.count_documents({})

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search using AstraDB's native lexical search.
        """
        if not self._doesCollectionExist():
            return []

        docs: List[Doc] = []

        # Convert docFilter to AstraDB filter format
        filter_dict = self._convertFilter(docFilter)

        # Pure lexical search using $lexical sort
        cursor = self.database.get_collection(self.collection_name).find(
            filter_dict,
            sort={'$lexical': query.text},  # Native BM25 lexical search
            limit=docFilter.limit,
            skip=docFilter.offset,
            projection={'$vector': 0},
        )

        # Convert results to your Doc format
        docs = self._convertToDocs(cursor)

        return docs

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search.
        """
        if not self._doesCollectionExist():
            return []

        filter_dict = self._convertFilter(docFilter)

        # Combine both lexical and vector search
        cursor = self.database.get_collection(self.collection_name).find(
            filter_dict,
            sort={'$vector': query.embedding},  # Automatic embedding generation + search
            limit=docFilter.limit,
            projection={'$lexical': 0},
            include_similarity=True,
            include_sort_vector=True,
        )

        # Convert results to your Doc format
        docs = self._convertToDocs(cursor)

        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Retrieve documents matching the filter.
        """
        if checkCollection and not self._doesCollectionExist():
            return []

        collection = self.database.get_collection(self.collection_name)

        filter_dict = self._convertFilter(docFilter)

        # Execute query
        cursor = collection.find(filter=filter_dict, limit=docFilter.limit or 100)

        # Convert to Doc objects
        documents = list(cursor)
        return self._convertToDocs(documents)

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        More efficient implementation using aggregation to get distinct parent paths.
        """
        if not self._doesCollectionExist():
            return {}

        # Build match stage filter
        match_filter = {'meta.chunkId': 0}

        if parent is not None:
            match_filter['meta.parent'] = parent

        # Use aggregation pipeline
        pipeline = [
            {'$match': match_filter},
            {
                '$group': {
                    '_id': '$meta.parent',
                    'objectId': {'$first': '$meta.objectId'},
                }
            },
            {'$skip': offset},
            {'$limit': limit},
        ]

        # Execute aggregation
        collection = self.database.get_collection(self.collection_name)
        results = collection.aggregate(pipeline)

        # Build paths dictionary
        paths: Dict[str, str] = {}
        for result in results:
            parent_path = result['_id']
            object_id = result['objectId']
            if parent_path and object_id:
                paths[parent_path] = object_id

        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the document store.
        """
        if not chunks:
            return

        if checkCollection and not self.createCollection(chunks):
            return

        collection = self.database.get_collection(self.collection_name)

        # Clear the documents list
        documents: List[Dict] = []

        # Clear the object id list for deletion
        objectIds: Dict = {}

        def flush():
            nonlocal documents
            nonlocal objectIds

            # First, delete existing documents if we have objectIds to delete
            if len(objectIds):
                # Delete all documents with these object IDs
                for objectId in objectIds.keys():
                    collection.delete_many({'meta.objectId': objectId})

            def is_valid_vector(vector):
                magnitude = sum(x * x for x in vector) ** 0.5
                return magnitude > 1e-6

            valid_docs = [doc for doc in documents if is_valid_vector(doc.get('$vector', [1]))]

            # Insert the new documents
            if len(valid_docs):
                collection.insert_many(valid_docs)

            # Clear them
            objectIds = {}
            documents = []

        # For each document, check if we need to delete existing chunks
        for chunk in chunks:
            # If we are writing chunk 0, then delete the object
            if not chunk.metadata.chunkId:
                # Save this object id to be deleted
                objectIds[chunk.metadata.objectId] = True

        # For each document, prepare the data for insertion
        for chunk in chunks:
            # Get the embedding
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            # Handle control document with zero vectors
            if chunk.metadata.objectId == 'schema' and all(x == 0 for x in embedding):
                embedding = [1e-8] * len(embedding)

            # Create the document structure for AstraDB
            document = {
                '_id': str(uuid4()),
                '$vector': DataAPIVector(embedding),
                'content': chunk.page_content,
                'meta': chunk.metadata.__dict__,  # Convert metadata to dict
            }

            documents.append(document)

            if len(documents) >= 500:
                flush()

        # Flush any remaining documents
        flush()

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the collection does not exists, there
        # is nothing to delete
        if not self._doesCollectionExist():
            return

        # Build a filter for an object id
        filter_objectId = {'meta.objectId': {'$in': objectIds}}

        collection = self.database.get_collection(self.collection_name)
        collection.delete_many(filter_objectId)
        return

    def markDeleted(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not self._doesCollectionExist():
            return

        # Build a filter for an object id
        filter_objectId = {'meta.objectId': {'$in': objectIds}}

        # Set all the objects with the given objectId to true
        collection = self.database.get_collection(self.collection_name)
        collection.update_many(filter_objectId, {'$set': {'meta.isDeleted': True}})
        return

    def markActive(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now 'comes back' after begin deleted
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not self._doesCollectionExist():
            return

        # Build a filter for an object id
        filter_objectId = {'meta.objectId': {'$in': objectIds}}

        # Set all the objects with the given objectId to true
        collection = self.database.get_collection(self.collection_name)
        collection.update_many(filter_objectId, {'$set': {'meta.isDeleted': False}})
        return

    # Since chunks are returned in any order, and a single objectId
    # may contain tens of thousands of chunks, we grave them one
    # group at a time (renderChunkSize), put them into an array,
    # join them and call the callback
    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order.
        """
        # By definition, if the collection does not exists, there
        # is nothing to render
        if not self._doesCollectionExist():
            return

        # Get the collection
        collection = self.database.get_collection(self.collection_name)

        # Find all chunks for the objectId
        cursor = collection.find(
            {
                'meta.objectId': objectId,
                'meta.isDeleted': False,  # Only get non-deleted chunks
            }
        )

        # Collect all chunks
        chunks = []
        for document in cursor:
            if 'content' not in document or 'meta' not in document:
                continue

            chunks.append({'chunkId': document['meta']['chunkId'], 'content': document['content']})

        # Sort by chunkId in application code (since AstraDB doesn't guarantee order)
        chunks.sort(key=lambda x: x['chunkId'])

        # Reconstruct document
        full_text = ''.join([chunk['content'] for chunk in chunks])
        callback(full_text)
