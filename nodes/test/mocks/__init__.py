# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
Mock Modules for Node Testing
==============================

This directory contains mock implementations of external libraries used by
RocketRide nodes. These mocks allow testing nodes without requiring actual
external services (databases, APIs, etc.) to be running.

How Mock Loading Works:
-----------------------
1. The test framework sets the ROCKETRIDE_MOCK environment variable to point
   to this directory (nodes/test/mocks/)

2. When the EAAS server spawns a subprocess to run a pipeline, it passes
   this environment variable to the subprocess

3. The node.py entry point checks for ROCKETRIDE_MOCK and, if set, inserts
   that path at the FRONT of sys.path

4. When node code does `import some_library`, Python searches sys.path
   in order and finds our mock BEFORE the real library

5. The mock completely shadows the real library - no code changes needed

Mock Coverage (all external calls go through mocks when ROCKETRIDE_MOCK is set):
------------------------------------------------------------------------------
- LLM providers: langchain_openai, langchain_anthropic, langchain_google_vertexai,
  langchain_aws, langchain_xai (Chat* classes return stub responses)
- LLM validateConfig: openai, anthropic (direct SDK - no real API calls)
- Vector stores: qdrant_client, weaviate, psycopg2, pgvector, pinecone,
  chromadb, pymilvus, astrapy

LLM credential placeholders (pipeline injects when ROCKETRIDE_MOCK): anthropic, xai,
openai, perplexity, deepseek, mistral, vision_mistral, gemini, ibm_watson, bedrock.

Not mocked (native SDK; would need mocks for full test): Mistral SDK, Google genai,
IBM Watson. Vertex/Bedrock use langchain mocks + credential placeholders.
Not mocked (tests use requires= or skip): OCR (img2table/opencv), embedding
transformer (sentence-transformers), NER (transformers), ibm_watsonx_ai.

Directory Structure:
--------------------
Each mock is a directory matching the library's package name:

    mocks/
        __init__.py              <- This file
        openai/                  <- Mock for openai SDK (validateConfig)
        anthropic/               <- Mock for anthropic SDK (validateConfig)
        langchain_openai/        <- Mock for ChatOpenAI, OpenAIEmbeddings
        langchain_anthropic/     <- Mock for ChatAnthropic
        langchain_google_vertexai/
        langchain_aws/
        langchain_xai/
        qdrant_client/           <- Mock for qdrant_client library
            __init__.py          <- Main mock implementation
            models.py            <- Mock data models
            conversions/         <- Mock submodules
            http/
        pinecone/                <- Mock for pinecone library (example)
            __init__.py
            ...
        weaviate/                <- Mock for weaviate library (example)
            __init__.py
            ...

Creating a New Mock:
--------------------
1. Identify the library to mock (e.g., `pinecone`)

2. Create a directory with the EXACT package name:
       mkdir nodes/test/mocks/pinecone

3. Create __init__.py that exports what the real library exports:
   - Main client class (e.g., Pinecone, PineconeClient)
   - Common types the node code uses
   - Any submodules the node code imports from

4. Implement the minimum API needed:
   - Only implement methods the node actually calls
   - Use class-level storage to persist data across instances

5. Handle serialization properly:
   - Return dicts, not Pydantic models, from query methods
   - Use model_dump(exclude_none=True) for Pydantic objects

6. Add test cases to the node's services.json:
   - Add a "test" section with "profiles" and "cases"
   - Each case specifies input data and expected output

7. Run tests:
       builder nodes:test --pytest="-k <node_name> -s -v"

Example Mock Pattern (Pinecone):
--------------------------------
# nodes/test/mocks/pinecone/__init__.py

from typing import List, Dict, Any

class Pinecone:
    '''Mock Pinecone client.'''
    
    _indexes: Dict[str, 'Index'] = {}
    
    def __init__(self, api_key: str = None, **kwargs):
        pass
    
    def Index(self, name: str) -> 'Index':
        if name not in Pinecone._indexes:
            Pinecone._indexes[name] = Index(name)
        return Pinecone._indexes[name]
    
    @classmethod
    def reset(cls):
        cls._indexes = {}


class Index:
    '''Mock Pinecone index.'''
    
    def __init__(self, name: str):
        self.name = name
        self._vectors: List[Dict[str, Any]] = []
    
    def upsert(self, vectors: List[Dict]) -> dict:
        self._vectors.extend(vectors)
        return {"upserted_count": len(vectors)}
    
    def query(self, vector: List[float], top_k: int = 10, **kwargs) -> dict:
        matches = [
            {"id": v["id"], "score": 0.95, "metadata": v.get("metadata", {})}
            for v in self._vectors[:top_k]
        ]
        return {"matches": matches}

Troubleshooting:
----------------
1. If mock isn't loading:
   - Verify ROCKETRIDE_MOCK env var is set in the test server
   - Check that node.py is adding the path to sys.path
   - Ensure directory name exactly matches the import name

2. If tests fail with validation errors:
   - Check that payloads are serialized to dicts (not Pydantic models)
   - Use model_dump(exclude_none=True) to avoid None values
   - Match the exact structure the node code expects

3. If data doesn't persist between test cases:
   - Use class-level storage (not instance variables)
   - Ensure test cases run in the same pipeline/subprocess

See Also:
---------
- nodes/test/mocks/qdrant_client/ - Complete example with thorough comments
- nodes/test/framework/discovery.py - How test configs are discovered
- nodes/test/framework/runner.py - How tests are executed
- packages/ai/src/ai/node.py - Where ROCKETRIDE_MOCK is injected into sys.path
"""
