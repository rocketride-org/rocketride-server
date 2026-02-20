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
# MongoDB Atlas Vector Store Implementation
# ------------------------------------------------------------------------------

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import List, Callable, Dict, Any, Optional
from uuid import uuid4
import sys
import numpy as np
import logging

from pymongo import MongoClient
from pymongo.collection import Collection
from pymongo.errors import CollectionInvalid, OperationFailure
from pymongo.database import Database
from pymongo.operations import SearchIndexModel

from pydantic import ValidationError

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config

logger = logging.getLogger(__name__)

"""
NOTE: MongoDB Atlas Vector Search requires:
1. An Atlas M10+ cluster or serverless instance
2. Search indexes created for vector search functionality
3. Proper index configuration for vector and metadata fields

Atlas Vector Search supports cosine similarity, euclidean distance, and dot product
similarity metrics for vector search operations.
"""


class Store(DocumentStoreBase):
    """
    MongoDB Atlas Vector Store implementation.

    Implements the abstract methods required by DocumentStoreBase for
    MongoDB Atlas vector search functionality.
    """

    host: str | None = None
    node: str = 'atlas'
    database_name: str = ''
    collection_name: str = ''
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'cosine'
    threshold_search: float = 0.0
    client: MongoClient | None = None
    host: str = ''
    database: Database | None = None
    collection: Collection | None = None
    vector_index_name: str = 'vector_index'
    text_index_name: str = 'text_index'

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the MongoDB Atlas vector store."""
        super().__init__(provider, connConfig, bag)

        # Get configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Store configuration
        self.database_name = config.get('database')
        self.collection_name = config.get('collection')
        self.host = config.get('host', '').strip()
        self.vector_index_name = config.get('vectorIndexName', 'vector_index')
        self.text_index_name = config.get('textIndexName', 'text_index')
        self.similarity = config.get('similarity', 'cosine').lower()
        self.threshold_search = config.get('score', 0.5)
        self.payload_limit = config.get('payloadLimit', 32 * 1024 * 1024)
        self.renderChunkSize = config.get('renderChunkSize', 32 * 1024 * 1024)

        # Validate similarity metric
        if self.similarity not in ['cosine', 'euclidean', 'dotproduct']:
            raise Exception('Similarity metric must be cosine, euclidean, or dotproduct')

        # Initialize MongoDB client
        self.client = MongoClient(self.host)
        self.database = self.client[self.database_name]
        self.collection = self.database[self.collection_name]

    def __del__(self):
        """Clean up MongoDB connection."""
        if hasattr(self, 'client') and self.client:
            self.client.close()

        # Deinit everything we did
        self.host = None
        self.database_name = ''
        self.collection_name = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'
        self.client = None
        self.database = None
        self.collection = None

    def _doesCollectionExist(self) -> bool:
        """Check if the collection exists."""
        if self.database is None:
            return False
        return self.collection_name in self.database.list_collection_names()

    def _createCollection(self, vectorSize: int) -> bool:
        """Create collection with necessary indexes."""
        self.vectorSize = vectorSize

        # Create collection if it doesn't exist
        if not self._doesCollectionExist():
            try:
                self.database.create_collection(self.collection_name)
                logger.info(f'Created MongoDB collection: {self.collection_name}')
            except CollectionInvalid:
                logger.info(f'Collection {self.collection_name} already exists')

        # Create regular indexes for metadata fields
        index_fields = [('meta.nodeId', 1), ('meta.objectId', 1), ('meta.parent', 1), ('meta.permissionId', 1), ('meta.isDeleted', 1), ('meta.isTable', 1), ('meta.chunkId', 1), ('meta.tableId', 1)]

        for field_spec in index_fields:
            try:
                self.collection.create_index([field_spec])
                logger.debug(f'Created index on {field_spec[0]}')
            except OperationFailure as e:
                logger.warning(f'Could not create index on {field_spec[0]}: {e}')

        # Create text index for keyword search
        try:
            self.collection.create_index([('content', 'text')], name=self.text_index_name)
            logger.info('Created text search index')
        except OperationFailure as e:
            logger.warning(f'Could not create text search index: {e}')

        # Create vector search index
        try:
            # Check if vector search index already exists
            existing_indexes = list(self.collection.list_search_indexes())
            vector_index_exists = any(idx.get('name') == self.vector_index_name for idx in existing_indexes)

            if not vector_index_exists:
                # Correct vector index definition format for Atlas
                vector_index_definition = {'mappings': {'dynamic': True, 'fields': {'embedding': {'type': 'knnVector', 'dimensions': vectorSize, 'similarity': self.similarity}}}}

                search_index = SearchIndexModel(definition=vector_index_definition, name=self.vector_index_name)

                # Create the search index directly without SearchIndexModel
                result = self.collection.create_search_index(search_index)

                logger.info(f'Created vector search index: {self.vector_index_name} with {vectorSize} dimensions, result: {result}')
            else:
                logger.info(f'Vector search index {self.vector_index_name} already exists')

        except Exception as e:
            logger.error(f'Could not create vector search index: {e}')
            logger.info('You may need to create the vector search index manually in Atlas UI')

        return True

    def count_documents(self) -> int:
        """Return the number of documents in the store."""
        if not self.doesCollectionExist():
            return 0
        return self.collection.count_documents({})

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """Perform keyword search using MongoDB text search."""
        if not self.doesCollectionExist():
            return []

        # Build filter conditions
        filter_conditions = self._convertFilter(docFilter)
        filter_conditions['$text'] = {'$search': query.text}

        # Build aggregation pipeline
        pipeline = [{'$match': filter_conditions}, {'$addFields': {'score': {'$meta': 'textScore'}}}, {'$sort': {'score': {'$meta': 'textScore'}}}, {'$skip': docFilter.offset or 0}, {'$limit': docFilter.limit or 25}]

        results = list(self.collection.aggregate(pipeline))
        return self._convertToDocs(results, include_score=True)

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """Perform semantic search using Atlas Vector Search."""
        if not self.doesCollectionExist():
            return []

        # Validate embedding model matches collection
        if not self.doesCollectionExist(query.embedding_model):
            raise Exception('Collection does not exist or model mismatch')

        if query.embedding is None:
            raise Exception('Embedding required for semantic search')

        if docFilter.offset:
            raise Exception('Non-zero offset not supported in semantic search')

        # Build filter conditions
        filter_conditions = self._convertFilter(docFilter)

        # Build vector search pipeline
        vector_search_stage = {'$vectorSearch': {'index': self.vector_index_name, 'path': 'embedding', 'queryVector': query.embedding, 'numCandidates': (docFilter.limit or 25) * 10, 'limit': docFilter.limit or 25}}

        if filter_conditions:
            vector_search_stage['$vectorSearch']['filter'] = filter_conditions

        pipeline = [vector_search_stage, {'$addFields': {'score': {'$meta': 'vectorSearchScore'}}}]

        try:
            results = list(self.collection.aggregate(pipeline))
            logger.info(f'Results: {results}')
        except OperationFailure as e:
            logger.error(f'OperationFailure: {e}')

        return self._convertToDocs(results, include_score=True)

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """Get documents matching the filter."""
        if checkCollection and not self.doesCollectionExist():
            return []

        filter_conditions = self._convertFilter(docFilter)
        cursor = self.collection.find(filter_conditions)

        if docFilter.offset:
            cursor = cursor.skip(docFilter.offset)
        if docFilter.limit:
            cursor = cursor.limit(docFilter.limit)

        documents = list(cursor)
        return self._convertToDocs(documents)

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """Get unique parent paths."""
        if not self.doesCollectionExist():
            return {}

        filter_conditions = {'meta.chunkId': 0}
        if parent is not None:
            filter_conditions['meta.parent'] = {'$regex': parent, '$options': 'i'}

        cursor = self.collection.find(filter_conditions).skip(offset).limit(limit)

        paths = {}
        for document in cursor:
            if 'meta' not in document:
                continue

            metadata = self._validateMetadata(document['meta'])
            if metadata is None:
                continue

            paths[metadata.parent] = metadata.objectId

        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """Add document chunks to the store."""
        if not chunks:
            return

        if checkCollection and not self.createCollection(chunks):
            return

        # Collect object IDs to delete
        objectIds = set()
        for chunk in chunks:
            if not chunk.metadata.chunkId:
                objectIds.add(chunk.metadata.objectId)

        # Delete existing documents with same object IDs
        if objectIds:
            self.collection.delete_many({'meta.objectId': {'$in': list(objectIds)}})

        # Prepare documents for insertion
        documents = []
        sum_size = 0

        for chunk in chunks:
            if chunk.embedding is None:
                raise Exception('No embedding in document')

            doc = {'_id': str(uuid4()), 'embedding': chunk.embedding, 'content': chunk.page_content, 'meta': chunk.metadata.__dict__}

            doc_size = sys.getsizeof(doc)
            sum_size += doc_size
            documents.append(doc)

            # Flush when batch size or payload limit is reached
            if len(documents) >= 500 or sum_size > self.payload_limit:
                self.collection.insert_many(documents)
                documents = []
                sum_size = 0

        # Insert remaining documents
        if documents:
            self.collection.insert_many(documents)

    def remove(self, objectIds: List[str]) -> None:
        """Remove documents by object IDs."""
        if not self.doesCollectionExist():
            return

        self.collection.delete_many({'meta.objectId': {'$in': objectIds}})

    def markDeleted(self, objectIds: List[str]) -> None:
        """Mark documents as deleted."""
        if not self.doesCollectionExist():
            return

        self.collection.update_many({'meta.objectId': {'$in': objectIds}}, {'$set': {'meta.isDeleted': True}})

    def markActive(self, objectIds: List[str]) -> None:
        """Mark documents as active (not deleted)."""
        if not self.doesCollectionExist():
            return

        self.collection.update_many({'meta.objectId': {'$in': objectIds}}, {'$set': {'meta.isDeleted': False}})

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """Render complete document by combining all chunks."""
        if not self.doesCollectionExist():
            return

        offset = 0
        while True:
            filter_conditions = {'meta.objectId': objectId, 'meta.chunkId': {'$gte': offset, '$lt': offset + self.renderChunkSize}}

            cursor = self.collection.find(filter_conditions).limit(self.renderChunkSize)
            documents = list(cursor)

            text = [''] * self.renderChunkSize
            lastIndex = -1

            for document in documents:
                if 'meta' not in document:
                    continue

                metadata = self._validateMetadata(document['meta'])
                if metadata is None:
                    continue

                content = document['content']
                chunk = metadata.chunkId

                if chunk < offset or chunk >= offset + self.renderChunkSize:
                    continue

                index = chunk - offset
                text[index] = content

                if index > lastIndex:
                    lastIndex = index

            numberOfItems = lastIndex + 1
            if numberOfItems < 1:
                break

            fullText = ''.join(text[0:numberOfItems])
            callback(fullText)

            if numberOfItems < self.renderChunkSize:
                break

            offset += self.renderChunkSize

    def _convertFilter(self, docFilter: DocFilter) -> Dict[str, Any]:
        """Convert DocFilter to MongoDB filter conditions."""
        filter_conditions = {}

        if docFilter.nodeId is not None:
            filter_conditions['meta.nodeId'] = docFilter.nodeId

        if docFilter.isTable is not None:
            filter_conditions['meta.isTable'] = docFilter.isTable

        if docFilter.tableIds is not None:
            filter_conditions['meta.tableId'] = {'$in': docFilter.tableIds}

        if docFilter.parent is not None:
            filter_conditions['meta.parent'] = {'$regex': docFilter.parent, '$options': 'i'}

        if docFilter.permissions is not None:
            filter_conditions['meta.permissionId'] = {'$in': docFilter.permissions}

        if docFilter.objectIds is not None:
            filter_conditions['meta.objectId'] = {'$in': docFilter.objectIds}

        if docFilter.chunkIds is not None:
            filter_conditions['meta.chunkId'] = {'$in': docFilter.chunkIds}

        if docFilter.minChunkId is not None:
            if 'meta.chunkId' not in filter_conditions:
                filter_conditions['meta.chunkId'] = {}
            filter_conditions['meta.chunkId']['$gte'] = docFilter.minChunkId

        if docFilter.maxChunkId is not None:
            if 'meta.chunkId' not in filter_conditions:
                filter_conditions['meta.chunkId'] = {}
            filter_conditions['meta.chunkId']['$lte'] = docFilter.maxChunkId

        return filter_conditions

    def _validateMetadata(self, meta_dict: Dict[str, Any]) -> Optional[DocMetadata]:
        """Validate and create DocMetadata with proper error handling."""
        required_fields = {'nodeId': (str, ''), 'parent': (str, ''), 'permissionId': (int, 0), 'isTable': (bool, False), 'tableId': (int, 0)}

        cleaned_meta = {}

        for field_name, (field_type, default_value) in required_fields.items():
            if field_name in meta_dict and meta_dict[field_name] is not None:
                try:
                    if field_type is bool:
                        if isinstance(meta_dict[field_name], str):
                            cleaned_meta[field_name] = meta_dict[field_name].lower() in ('true', '1', 'yes')
                        else:
                            cleaned_meta[field_name] = bool(meta_dict[field_name])
                    elif field_type is int:
                        cleaned_meta[field_name] = int(meta_dict[field_name])
                    elif field_type is str:
                        cleaned_meta[field_name] = str(meta_dict[field_name])
                    else:
                        cleaned_meta[field_name] = meta_dict[field_name]
                except (ValueError, TypeError) as e:
                    logger.warning(f'Failed to convert {field_name}: {e}')
                    cleaned_meta[field_name] = default_value
            else:
                cleaned_meta[field_name] = default_value

        # Copy additional fields
        for key, value in meta_dict.items():
            if key not in required_fields:
                cleaned_meta[key] = value

        try:
            return DocMetadata(**cleaned_meta)
        except ValidationError as e:
            logger.error(f'Failed to create DocMetadata: {e}')
            return None

    def _convertToDocs(self, documents: List[Dict[str, Any]], include_score: bool = False) -> List[Doc]:
        """Convert MongoDB documents to Doc objects."""
        docs = []

        for doc in documents:
            if 'meta' not in doc:
                logger.warning("Document missing 'meta' field")
                continue

            metadata = self._validateMetadata(doc['meta'])
            if metadata is None:
                continue

            content = doc.get('content', '')

            if include_score and 'score' in doc:
                score = doc['score']
                if self.similarity == 'cosine':
                    score = (score + 1) / 2
                else:
                    score = float(1.0 / (1.0 + np.exp(score / -100)))

                if score < 0.20:
                    continue
            else:
                score = 0

            doc_obj = Doc(score=score, page_content=content, metadata=metadata)
            docs.append(doc_obj)

        return docs
