# RocketRide Component Reference

Complete catalog of all RocketRide pipeline components, organized by category.

**Last Updated:** Based on RocketRide codebase October 2025

---

## Table of Contents

- [Component Index](#component-index)
- [Source Components](#source-components)
- [Data Processing](#data-processing)
- [Text Processing](#text-processing)
- [Image Processing](#image-processing)
- [Audio Processing](#audio-processing)
- [Preprocessors](#preprocessors)
- [Embedding Models](#embedding-models)
- [Large Language Models (LLMs)](#large-language-models-llms)
- [Vector Databases](#vector-databases)
- [Cloud Connectors](#cloud-connectors)
- [Database Connectors](#database-connectors)
- [Output & Infrastructure](#output--infrastructure)
- [Advanced Components](#advanced-components)

---

## Component Index

Quick reference table of all components:

| Provider | Class | Lanes In → Out | Purpose |
|----------|-------|----------------|---------|
| **SOURCE COMPONENTS** |
| `webhook` | source | — → tags, text, audio, video, image | HTTP endpoint for file uploads |
| `chat` | source | — → questions | Web-based chat interface |
| `dropper` | source | — → tags | Drag-and-drop file upload UI |
| `filesys` | source | — → tags | Local file system reader |
| `sharepoint` | source | — → tags | Microsoft SharePoint |
| `sharepoint_on_prem` | source | — → tags | On-premises SharePoint |
| `onedrive` | source | — → tags | Microsoft OneDrive |
| `google` | source | — → tags | Google Drive & Gmail |
| `slack` | source | — → tags | Slack workspace |
| `atlassian` | source | — → tags | Confluence & Jira |
| `web_firecrawl` | source | — → tags | Web scraping with FireCrawl |
| **DATA PROCESSING** |
| `parse` | data | tags → text, table, image, audio, video | Extract content from documents |
| `llamaparse` | data | tags → text, table | Advanced document parsing |
| `reducto` | data | tags → text | Document processing service |
| `catalog` | infrastructure | * → * | Document cataloging |
| **TEXT PROCESSING** |
| `question` | text | text → questions | Convert text to questions |
| `summarization` | text | text → text, documents | Generate summaries |
| `anonymize` | text | text → text | PII detection/removal |
| `extract_data` | text | text → text | Structured data extraction |
| `dictionary` | utility | text → text | Dictionary lookups |
| `prompt` | utility | text → text | Prompt engineering |
| **IMAGE PROCESSING** |
| `ocr` | image | image, documents → text, table | Optical character recognition |
| `image_cleanup` | image | image → image | Image enhancement |
| `thumbnail` | image | image → image | Thumbnail generation |
| `frame_grabber` | video | video → image | Video frame extraction |
| `embedding_image` | embedding | image → image | Image embeddings |
| **AUDIO PROCESSING** |
| `audio_transcribe` | audio | audio → text | Audio to text transcription |
| `audio_player` | audio | audio → audio | Audio playback |
| **PREPROCESSORS** |
| `preprocessor_langchain` | preprocessor | text, table → documents | General text chunking |
| `preprocessor_code` | preprocessor | text → documents | Source code chunking |
| `preprocessor_llm` | preprocessor | text → documents | LLM-based preprocessing |
| **EMBEDDINGS** |
| `embedding_transformer` | embedding | documents, questions → documents, questions | Sentence transformers |
| `embedding_openai` | embedding | documents, questions → documents, questions | OpenAI embeddings |
| `embedding_image` | embedding | image → image | Image embeddings |
| **LLMs** |
| `llm_openai` | llm | questions → answers | GPT-4, GPT-3.5 |
| `llm_anthropic` | llm | questions → answers | Claude 3 |
| `llm_gemini` | llm | questions → answers | Google Gemini |
| `llm_mistral` | llm | questions → answers | Mistral AI |
| `llm_ollama` | llm | questions → answers | Local LLMs |
| `llm_bedrock` | llm | questions → answers | AWS Bedrock |
| `llm_vertex` | llm | questions → answers | Google Vertex AI |
| `llm_ibm_watson` | llm | questions → answers | IBM Watson |
| `llm_deepseek` | llm | questions → answers | DeepSeek |
| `llm_xai` | llm | questions → answers | xAI Grok |
| `llm_perplexity` | llm | questions → answers | Perplexity AI |
| `llm_vision_mistral` | llm | questions → answers | Mistral Vision (multimodal) |
| **VECTOR DATABASES** |
| `qdrant` | store | documents → —, questions → documents, answers, questions | Qdrant vector DB |
| `chroma` | store | documents → —, questions → documents, answers, questions | ChromaDB |
| `pinecone` | store | documents → —, questions → documents, answers, questions | Pinecone |
| `weaviate` | store | documents → —, questions → documents, answers, questions | Weaviate |
| `milvus` | store | documents → —, questions → documents, answers, questions | Milvus |
| `astra_db` | store | documents → —, questions → documents, answers, questions | DataStax Astra DB |
| `vectordb_postgres` | store | documents → —, questions → documents, answers, questions | PostgreSQL pgvector |
| **OUTPUT** |
| `response` | infrastructure | * → — | JSON response |
| `text_output` | infrastructure | text → — | File output |
| **DATABASES** |
| `db_mysql` | database | — | MySQL connector |
| **ADVANCED** |
| `agent_langchain` | agent | * → * | LangChain agents |
| `autopipe` | utility | — | Auto pipeline generation |
| `vectorizer` | utility | text → documents | Vectorization |
| `remote` | infrastructure | * → * | Remote execution |
| `upper` | transform | text → text | Transform example |

---

## Source Components

Components that serve as entry points for data into the pipeline.

### webhook

**Provider:** `webhook`  
**Class:** source  
**Lanes:** Produces `tags`, `text`, `audio`, `video`, `image`

Listens for incoming HTTP requests and accepts uploaded documents or data from external systems.

**Configuration:**
```json
{
  "id": "webhook_1",
  "provider": "webhook",
  "config": {
    "key": "webhook://*",
    "mode": "Source",
    "type": "webhook",
    "parameters": {
      "endpoint": "/pipe/process",
      "port": 5565
    }
  }
}
```

**Use Cases:**
- Accept document uploads via HTTP
- Integrate with external systems
- API-based document ingestion
- Trigger processing from webhooks

---

### chat

**Provider:** `chat`  
**Class:** source  
**Lanes:** Produces `questions`

Provides a web-based chat interface for interactive question answering. Creates its own HTTP endpoint configured by host and port.

**Configuration:**
```json
{
  "id": "chat_1",
  "provider": "chat",
  "config": {
    "hideForm": true,
    "mode": "Source",
    "type": "chat"
  }
}
```

**Use Cases:**
- Interactive chatbot interface
- Question answering applications
- Document Q&A systems
- Customer support bots

---

### filesys

**Provider:** `filesys`  
**Class:** source  
**Lanes:** Produces `tags`

Reads files from the local file system for processing.

**Configuration:**
```json
{
  "id": "source_1",
  "provider": "filesys",
  "config": {
    "include": [
      {
        "path": "C:\\data\\documents",
        "classify": true,
        "index": true,
        "ocr": false
      }
    ],
    "type": "filesys"
  }
}
```

**Use Cases:**
- Batch process local files
- Automated folder monitoring
- Legacy system integration

---

### dropper

**Provider:** `dropper`  
**Class:** source  
**Lanes:** Produces `tags`

Drag-and-drop file upload interface for user-friendly file selection.

**Configuration:**
```json
{
  "id": "dropper_1",
  "provider": "dropper",
  "config": {
    "hideForm": true,
    "mode": "Source",
    "type": "dropper"
  }
}
```

---

### web_firecrawl

**Provider:** `web_firecrawl`  
**Class:** source  
**Lanes:** Produces `tags`

Web scraping component using FireCrawl integration for automated content extraction from websites.

**Use Cases:**
- Scrape website content
- Extract web data
- Monitor web pages
- Content aggregation

---

## Cloud Connectors

### sharepoint

**Provider:** `sharepoint`  
**Class:** source  
**Lanes:** Produces `tags`

Microsoft SharePoint cloud connector for accessing SharePoint Online documents and content.

**Use Cases:**
- Access SharePoint documents
- Enterprise document management
- Microsoft 365 integration

---

### onedrive

**Provider:** `onedrive`  
**Class:** source  
**Lanes:** Produces `tags`

Microsoft OneDrive connector for accessing cloud-stored files.

**Profiles:**
- `personal` - Personal OneDrive accounts
- `enterprise` - Business/Enterprise accounts

---

### google

**Provider:** `google`  
**Class:** source  
**Lanes:** Produces `tags`

Google Drive and Gmail connector for accessing Google Workspace content.

**Services:**
- Google Drive file access
- Gmail email processing

---

### slack

**Provider:** `slack`  
**Class:** source  
**Lanes:** Produces `tags`

Slack workspace connector for accessing messages, files, and channel content.

**Profiles:**
- `personal` - Personal workspace
- `enterprise` - Enterprise Grid

---

### atlassian

**Provider:** `atlassian`  
**Class:** source  
**Lanes:** Produces `tags`

Atlassian connector for Confluence and Jira integration.

**Services:**
- Confluence page content
- Jira issue data

---

## Data Processing

### parse

**Provider:** `parse`  
**Class:** data  
**Lanes:** `tags` → `text`, `table`, `image`, `audio`, `video`

Document parsing component that extracts rich content from a wide variety of document types. Automatically identifies and processes embedded content.

**Configuration:**
```json
{
  "id": "parser_1",
  "provider": "parse",
  "config": {}
}
```

**Supported Formats:**
- PDF documents
- Microsoft Office (DOCX, XLSX, PPTX)
- Images (JPEG, PNG, GIF)
- Audio files
- Video files
- Text files
- HTML
- And many more

**Outputs:**
- `text` - Plain text content
- `table` - Structured table data
- `image` - Embedded images
- `audio` - Audio streams
- `video` - Video streams

**Use Cases:**
- Extract text from PDFs
- Parse Office documents
- Extract embedded media
- General document processing

---

### llamaparse

**Provider:** `llamaparse`  
**Class:** data  
**Lanes:** `tags` → `text`, `table`

Advanced document parsing using LlamaParse for complex document structures.

**Use Cases:**
- Complex PDF parsing
- Scientific documents
- Forms and structured layouts
- High-accuracy extraction

---

### reducto

**Provider:** `reducto`  
**Class:** data  
**Lanes:** `tags` → `text`

Document processing service for advanced content extraction.

---

## Text Processing

### question

**Provider:** `question`  
**Class:** text  
**Lanes:** `text` → `questions`

Transformation component that takes input text and encapsulates it as a Question object for downstream processing.

**Configuration:**
```json
{
  "id": "question_1",
  "provider": "question",
  "config": {
    "profile": "default",
    "default": {
      "question": "What are the main findings?"
    }
  }
}
```

**Use Cases:**
- Convert text to question format
- Prepare queries for LLMs
- Question standardization

---

### summarization

**Provider:** `summarization`  
**Class:** text  
**Lanes:** `text` → `text`, `documents`

Processing component that analyzes document content to extract concise summaries, key points, and named entities.

**Configuration:**
```json
{
  "id": "summary_1",
  "provider": "summarization",
  "config": {
    "profile": "default",
    "default": {
      "numberOfSummaries": 5,
      "numberOfSummaryWords": 100,
      "numberOfKeyPointWords": 50,
      "numberOfEntities": 10
    }
  }
}
```

**Requires:** LLM connection via `control` array

**Outputs:**
- Summaries of document chunks
- Key points extraction
- Named entity recognition
- Structured insights

**Use Cases:**
- Document summarization
- Key point extraction
- Entity extraction
- Content distillation

---

### anonymize

**Provider:** `anonymize`  
**Class:** text  
**Lanes:** `text` → `text`

PII (Personally Identifiable Information) detection and removal component for compliance and privacy.

**Detects:**
- Social Security Numbers
- Credit card numbers
- Email addresses
- Phone numbers
- Names and addresses
- Custom patterns

**Use Cases:**
- GDPR compliance
- HIPAA compliance
- CCPA compliance
- Data sanitization
- Privacy protection

---

### extract_data

**Provider:** `extract_data`  
**Class:** text  
**Lanes:** `text` → `text`

Structured data extraction from unstructured text.

**Use Cases:**
- Extract structured fields
- Form data extraction
- Invoice processing
- Data mining

---

### dictionary

**Provider:** `dictionary`  
**Class:** utility  
**Lanes:** `text` → `text`

Dictionary lookups and translations for text processing.

---

### prompt

**Provider:** `prompt`  
**Class:** utility  
**Lanes:** `text` → `text`

Prompt engineering and management component for LLM interactions.

---

## Preprocessors

Components that chunk and prepare text for embedding and vector storage.

### preprocessor_langchain

**Provider:** `preprocessor_langchain`  
**Class:** preprocessor  
**Lanes:** `text`, `table` → `documents`

Preprocessing component that segments large bodies of text into intelligently sized chunks. Uses LangChain text splitters.

**Configuration:**
```json
{
  "id": "preprocessor_1",
  "provider": "preprocessor_langchain",
  "config": {
    "profile": "default",
    "default": {
      "mode": "strlen",
      "splitter": "RecursiveCharacterTextSplitter",
      "strlen": 512
    }
  }
}
```

**Available Splitters:**
- `RecursiveCharacterTextSplitter` - General-purpose (default)
- `CharacterTextSplitter` - Simple splitting with fixed separator
- `MarkdownTextSplitter` - Markdown-aware splitting
- `LatexTextSplitter` - LaTeX document splitting
- `NLTKTextSplitter` - Sentence-based using NLTK
- `SpacyTextSplitter` - Advanced NLP-based splitting

**Modes:**
- `strlen` - Split by string length (characters)
- `tokens` - Split by estimated token count

**Chunk Size Recommendations:**
- General text: 512-1024 chars
- Code: 256-512 chars
- Legal documents: 1024-2048 chars

**Use Cases:**
- Prepare text for embeddings
- Chunk documents for RAG
- Context window management
- Semantic chunking

---

### preprocessor_code

**Provider:** `preprocessor_code`  
**Class:** preprocessor  
**Lanes:** `text` → `documents`

Specialized preprocessor for source code that understands programming language structure.

**Use Cases:**
- Code documentation
- Code search systems
- Developer tools

---

### preprocessor_llm

**Provider:** `preprocessor_llm`  
**Class:** preprocessor  
**Lanes:** `text` → `documents`

LLM-based preprocessing for intelligent content segmentation.

---

## Image Processing

### ocr

**Provider:** `ocr`  
**Class:** image  
**Lanes:** `image`, `documents` → `text`, `table`

Optical character recognition component that extracts machine-readable text from images and scanned documents.

**Configuration:**
```json
{
  "id": "ocr_1",
  "provider": "ocr",
  "config": {
    "profile": "default",
    "default": {
      "language": "en",
      "table": "Doctr"
    }
  }
}
```

**Supported Languages:** 80+ including:
- English (en)
- Spanish (es)
- French (fr)
- German (de)
- Chinese (ch_sim, ch_tra)
- Japanese (ja)
- Korean (ko)
- Arabic (ar)
- Russian (ru)
- And many more...

**OCR Engines:**
- **Doctr** - Default, good balance (default)
- **EasyOCR** - Alternative engine
- **PaddleOCR** - Paddle engine
- **SuryaOCR** - Surya engine
- **GCPOCR** - Google Cloud Vision

**Use Cases:**
- Extract text from scanned documents
- Process image-based PDFs
- Digitize printed materials
- Form processing
- Receipt/invoice OCR

---

### image_cleanup

**Provider:** `image_cleanup`  
**Class:** image  
**Lanes:** `image` → `image`

Image enhancement and cleanup component to improve OCR accuracy and image quality.

**Use Cases:**
- Pre-OCR image enhancement
- Noise reduction
- Contrast improvement
- Deskewing

---

### thumbnail

**Provider:** `thumbnail`  
**Class:** image  
**Lanes:** `image` → `image`

Generates thumbnails from images for preview and display purposes.

---

### frame_grabber

**Provider:** `frame_grabber`  
**Class:** video  
**Lanes:** `video` → `image`

Extracts frames from video files for analysis and processing.

**Use Cases:**
- Video content analysis
- Thumbnail generation from video
- Scene detection
- Video indexing

---

## Audio Processing

### audio_transcribe

**Provider:** `audio_transcribe`  
**Class:** audio  
**Lanes:** `audio` → `text`

Transcribes audio content to text using speech recognition.

**Use Cases:**
- Meeting transcription
- Podcast processing
- Voice note conversion
- Audio content indexing

---

### audio_player

**Provider:** `audio_player`  
**Class:** audio  
**Lanes:** `audio` → `audio`

Audio playback component for testing and verification.

---

## Embedding Models

Components that convert text/images into vector representations for semantic search.

### embedding_transformer

**Provider:** `embedding_transformer`  
**Class:** embedding  
**Lanes:** `documents` → `documents`, `questions` → `questions`

Transforms text into numerical vector representations using sentence transformer models from HuggingFace.

**Configuration:**
```json
{
  "id": "embedding_1",
  "provider": "embedding_transformer",
  "config": {
    "profile": "miniLM"
  }
}
```

**Available Models:**
- **miniLM** - `multi-qa-MiniLM-L6-cos-v1` (default)
  - Fast, good quality
  - General-purpose embeddings
  - Vector size: 384

- **miniAll** - `all-MiniLM-L6-v2`
  - Alternative fast model
  - Similar performance

- **mpnet** - `multi-qa-mpnet-base-cos-v1`
  - Better quality
  - Slightly slower
  - More accurate retrieval

- **custom** - Specify any HuggingFace model

**Use Cases:**
- Create document embeddings for vector storage
- Embed questions for semantic search
- RAG systems
- Similarity search

**GPU Support:** Yes (optional, improves performance)

---

### embedding_openai

**Provider:** `embedding_openai`  
**Class:** embedding  
**Lanes:** `documents` → `documents`, `questions` → `questions`

Uses OpenAI's embedding models (text-embedding-ada-002, etc.) for high-quality embeddings.

**Configuration:**
```json
{
  "id": "embedding_1",
  "provider": "embedding_openai",
  "config": {
    "apikey": "${ROCKETRIDE_OPENAI_KEY}",
    "model": "text-embedding-ada-002"
  }
}
```

**Use Cases:**
- High-quality embeddings
- OpenAI ecosystem integration
- Production RAG systems

---

### embedding_image

**Provider:** `embedding_image`  
**Class:** embedding  
**Lanes:** `image` → `image`

Creates vector embeddings from images for similarity search and classification.

**Use Cases:**
- Image similarity search
- Visual search systems
- Image classification
- Duplicate detection

---

## Large Language Models (LLMs)

Components that connect to various LLM providers for question answering and text generation.

**Common Lane Flow:** `questions` → `answers`

### llm_openai

**Provider:** `llm_openai`  
**Class:** llm  
**Lanes:** `questions` → `answers`

OpenAI GPT models for advanced natural language processing.

**Configuration:**
```json
{
  "id": "llm_1",
  "provider": "llm_openai",
  "config": {
    "profile": "openai-5",
    "openai-5": {
      "apikey": "${ROCKETRIDE_OPENAI_KEY}",
      "model": "gpt-4-turbo",
      "modelTotalTokens": 16384,
      "project": "MyProject"
    }
  }
}
```

**Available Profiles:**
- **openai-5** - GPT-4 Turbo
  - Best quality
  - 16K token context
  - Slower, more expensive

- **openai-3_5-16K** - GPT-3.5 Turbo 16K
  - Fast responses
  - Good quality
  - Cost-effective

- **openai-3_5-4K** - GPT-3.5 Turbo 4K
  - Fastest
  - Lowest cost
  - 4K context

**Use Cases:**
- Question answering
- Text generation
- Summarization
- Code generation
- RAG systems

---

### llm_anthropic

**Provider:** `llm_anthropic`  
**Class:** llm  
**Lanes:** `questions` → `answers`

Anthropic Claude models known for long context and reasoning capabilities.

**Models:**
- Claude 3 Opus - Highest capability
- Claude 3 Sonnet - Balanced
- Claude 3 Haiku - Fastest

**Key Features:**
- 200K+ token context window
- Strong reasoning
- Safety-focused

---

### llm_gemini

**Provider:** `llm_gemini`  
**Class:** llm  
**Lanes:** `questions` → `answers`

Google Gemini models for multimodal and cost-effective AI.

**Models:**
- Gemini Pro
- Gemini Ultra

**Key Features:**
- Multimodal support
- Cost-effective
- Fast inference

---

### llm_mistral

**Provider:** `llm_mistral`  
**Class:** llm  
**Lanes:** `questions` → `answers`

Mistral AI models offering open-source alternatives with strong performance.

**Models:**
- Mistral Large
- Mistral Medium
- Mixtral 8x7B

---

### llm_ollama

**Provider:** `llm_ollama`  
**Class:** llm  
**Lanes:** `questions` → `answers`

Run LLMs locally using Ollama for private, offline AI processing.

**Configuration:**
```json
{
  "id": "llm_1",
  "provider": "llm_ollama",
  "config": {
    "profile": "llama3",
    "llama3": {
      "host": "http://localhost:11434",
      "model": "llama3"
    }
  }
}
```

**Supported Models:**
- Llama 3
- Mistral
- Phi-3
- Gemma
- And many more

**Key Features:**
- Local execution
- No API costs
- Privacy-focused
- Offline capable

---

### llm_bedrock

**Provider:** `llm_bedrock`  
**Class:** llm  
**Lanes:** `questions` → `answers`

AWS Bedrock managed LLM service with multiple model options.

**Available Models:**
- Claude (Anthropic)
- Llama (Meta)
- Titan (Amazon)
- Mistral

---

### llm_vertex

**Provider:** `llm_vertex`  
**Class:** llm  
**Lanes:** `questions` → `answers`

Google Cloud Vertex AI models for enterprise ML.

---

### llm_ibm_watson

**Provider:** `llm_ibm_watson`  
**Class:** llm  
**Lanes:** `questions` → `answers`

IBM Watson AI models for enterprise applications.

---

### llm_deepseek

**Provider:** `llm_deepseek`  
**Class:** llm  
**Lanes:** `questions` → `answers`

DeepSeek models for code and reasoning.

---

### llm_xai

**Provider:** `llm_xai`  
**Class:** llm  
**Lanes:** `questions` → `answers`

xAI Grok models with real-time information.

---

### llm_perplexity

**Provider:** `llm_perplexity`  
**Class:** llm  
**Lanes:** `questions` → `answers`

Perplexity AI models with web search integration.

---

### llm_vision_mistral

**Provider:** `llm_vision_mistral`  
**Class:** llm  
**Lanes:** `questions` → `answers`

Mistral Vision models supporting multimodal inputs (text + images).

**Key Features:**
- Image understanding
- Visual question answering
- Multimodal reasoning

---

## Vector Databases

Components for storing and searching vector embeddings. All vector databases follow similar patterns.

**Common Behavior:**
- **Store Mode** (`documents` input): Stores embedded documents
- **Search Mode** (`questions` input): Retrieves similar documents

**Lane Flow:**
- Input `documents` → Store (no output)
- Input `questions` → Output `documents`, `answers`, `questions`

### qdrant

**Provider:** `qdrant`  
**Class:** store  
**Lanes:** `documents` → —, `questions` → `documents`, `answers`, `questions`

Qdrant vector database for efficient storage and retrieval of embeddings.

**Configuration:**
```json
{
  "id": "qdrant_1",
  "provider": "qdrant",
  "config": {
    "profile": "local",
    "local": {
      "host": "localhost",
      "port": 6333,
      "collection": "documents",
      "score": 0.7
    }
  }
}
```

**Profiles:**
- **local** - Self-hosted Qdrant server
  - Default port: 6333
  - Run with: `docker run -p 6333:6333 qdrant/qdrant`

- **cloud** - Qdrant Cloud service
  - Requires API key
  - Managed service

**Parameters:**
- `collection` - Collection name
- `score` - Similarity threshold (0.0-1.0)
- `host` - Server hostname
- `port` - Server port

**Use Cases:**
- RAG document storage
- Semantic search
- Similarity search
- Production vector DB

**Documentation:** https://qdrant.tech/

---

### chroma

**Provider:** `chroma`  
**Class:** store  
**Lanes:** `documents` → —, `questions` → `documents`, `answers`, `questions`

ChromaDB vector database - simple, embedded vector database.

**Configuration:**
```json
{
  "id": "chroma_1",
  "provider": "chroma",
  "config": {
    "profile": "local",
    "local": {
      "host": "localhost",
      "port": 8000,
      "collection": "documents"
    }
  }
}
```

**Profiles:**
- **local** - Local ChromaDB
  - Can run embedded or as server
  - Simple setup

- **cloud** - ChromaDB Cloud
  - Managed service

**Key Features:**
- Easy setup
- Good for development
- Python-first design
- Embedded mode available

**Documentation:** https://www.trychroma.com/

---

### pinecone

**Provider:** `pinecone`  
**Class:** store  
**Lanes:** `documents` → —, `questions` → `documents`, `answers`, `questions`

Pinecone cloud vector database optimized for production deployments.

**Key Features:**
- Fully managed
- Highly scalable
- Low latency
- Enterprise support

**Use Cases:**
- Production RAG systems
- High-scale applications
- Enterprise deployments

**Documentation:** https://www.pinecone.io/

---

### weaviate

**Provider:** `weaviate`  
**Class:** store  
**Lanes:** `documents` → —, `questions` → `documents`, `answers`, `questions`

Weaviate vector database with GraphQL API and hybrid search capabilities.

**Key Features:**
- Hybrid search (vector + keyword)
- GraphQL API
- Schema management
- RESTful API

**Use Cases:**
- Hybrid search systems
- Knowledge graphs
- Complex queries

**Documentation:** https://weaviate.io/

---

### milvus

**Provider:** `milvus`  
**Class:** store  
**Lanes:** `documents` → —, `questions` → `documents`, `answers`, `questions`

Milvus vector database for large-scale, distributed deployments.

**Key Features:**
- Highly scalable
- Distributed architecture
- GPU support
- High performance

**Use Cases:**
- Large-scale deployments
- Enterprise systems
- High-performance requirements

**Documentation:** https://milvus.io/

---

### astra_db

**Provider:** `astra_db`  
**Class:** store  
**Lanes:** `documents` → —, `questions` → `documents`, `answers`, `questions`

DataStax Astra DB with vector search capabilities built on Cassandra.

**Key Features:**
- Built on Cassandra
- Global distribution
- Multi-cloud
- Enterprise-grade

**Use Cases:**
- Existing Cassandra users
- Global applications
- Multi-region deployments

**Documentation:** https://www.datastax.com/products/datastax-astra

---

### vectordb_postgres

**Provider:** `vectordb_postgres`  
**Class:** store  
**Lanes:** `documents` → —, `questions` → `documents`, `answers`, `questions`

PostgreSQL with pgvector extension for vector storage.

**Key Features:**
- Use existing PostgreSQL
- SQL interface
- ACID compliance
- Familiar tooling

**Use Cases:**
- Existing PostgreSQL infrastructure
- SQL-based queries
- Hybrid data (vectors + relational)

**Documentation:** https://github.com/pgvector/pgvector

---

## Database Connectors

### db_mysql

**Provider:** `db_mysql`  
**Class:** database

MySQL database connector for reading and writing data.

**Use Cases:**
- Read from databases
- Write results to databases
- Data pipeline integration

---

## Output & Infrastructure

### response

**Provider:** `response`  
**Class:** infrastructure  
**Lanes:** Accepts all lane types → —

Sends processed data back to the requesting client in JSON format. Handles the response phase of the HTTP request-response cycle.

**Configuration:**
```json
{
  "id": "response_1",
  "provider": "response",
  "config": {
    "lanes": [
      {
        "laneId": "answers",
        "laneName": "chat_response"
      },
      {
        "laneId": "text",
        "laneName": "extracted_text"
      }
    ]
  }
}
```

**Parameters:**
- `lanes` - Map lane types to custom JSON keys in response
  - `laneId` - Lane type (text, answers, documents, etc.)
  - `laneName` - Custom key name in JSON response

**Use Cases:**
- Return pipeline results
- HTTP API responses
- Client communication

---

### text_output

**Provider:** `text_output`  
**Class:** infrastructure  
**Lanes:** `text` → —

Outputs text content to files or streams.

**Use Cases:**
- Write results to files
- Export processed text
- Logging and archiving

---

### catalog

**Provider:** `catalog`  
**Class:** infrastructure

Catalogs processed documents with metadata for tracking and organization.

---

### remote

**Provider:** `remote`  
**Class:** infrastructure

Execute pipelines or components on remote RocketRide instances.

**Use Cases:**
- Distributed processing
- Load balancing
- Remote execution

---

## Advanced Components

### agent_langchain

**Provider:** `agent_langchain`  
**Class:** agent

LangChain agent integration for autonomous task execution and tool use.

**Use Cases:**
- Autonomous agents
- Tool-using LLMs
- Complex reasoning
- Multi-step workflows

---

### autopipe

**Provider:** `autopipe`  
**Class:** utility

Automatic pipeline generation based on requirements.

**Use Cases:**
- Dynamic pipeline creation
- Template-based pipelines
- Automated workflows

---

### vectorizer

**Provider:** `vectorizer`  
**Class:** utility  
**Lanes:** `text` → `documents`

Vectorization utilities for text processing.

---

### upper

**Provider:** `upper`  
**Class:** transform  
**Lanes:** `text` → `text`

Example transform component that converts text to uppercase. Useful as a template for custom components.

---

## Component Selection Guide

### Choose a Source Component

| Need | Use | Client Method | Example |
|------|-----|---------------|---------|
| **Chat/Q&A system** | `chat` | `client.chat()` | Chatbots, conversational AI, RAG Q&A (any interface: web, console, API, mobile) |
| **Document uploads** | `webhook` | `client.send()`, `client.send_files()` | API integration, file ingestion, ETL pipelines |
| **Local files** | `filesys` | Auto-processed | Batch processing, folder monitoring |
| **Drag & drop** | `dropper` | `client.send_files()` | User file uploads |
| **SharePoint** | `sharepoint` | Auto-processed | Enterprise docs |
| **Google Drive** | `google` | Auto-processed | Cloud storage |
| **Web scraping** | `web_firecrawl` | Auto-processed | Website content |

**Critical Distinction:**
- **Use `chat` component for ALL conversational interfaces** - Whether web UI, console, API, or mobile app. The `chat` component is not just for web interfaces; it's the source for any Q&A pipeline. Use with `client.chat()` method.
- **Use `webhook` component for document/data processing** - File uploads, document ingestion, ETL. Use with `client.send()` or `client.send_files()` methods.

### Choose an LLM

| Priority | Use | Provider |
|----------|-----|----------|
| Best quality | GPT-4, Claude Opus | `llm_openai`, `llm_anthropic` |
| Speed | GPT-3.5, Gemini | `llm_openai`, `llm_gemini` |
| Cost | Mistral, Gemini | `llm_mistral`, `llm_gemini` |
| Local/Private | Llama, Mistral | `llm_ollama` |
| Long context | Claude | `llm_anthropic` |
| Multimodal | Gemini, Mistral Vision | `llm_gemini`, `llm_vision_mistral` |

### Choose a Vector Database

| Priority | Use | Provider |
|----------|-----|----------|
| Easy setup | ChromaDB | `chroma` |
| Production | Qdrant, Pinecone | `qdrant`, `pinecone` |
| Existing Postgres | pgvector | `vectordb_postgres` |
| Hybrid search | Weaviate | `weaviate` |
| Large scale | Milvus | `milvus` |
| Cassandra users | Astra DB | `astra_db` |

### Choose a Preprocessor

| Content Type | Use | Provider |
|--------------|-----|----------|
| General text | Default | `preprocessor_langchain` |
| Source code | Code-aware | `preprocessor_code` |
| LLM-based | Smart chunking | `preprocessor_llm` |

---

## Component Compatibility Matrix

### Source → Parser
- `webhook` → `parse` ✓
- `filesys` → `parse` ✓
- `dropper` → `parse` ✓
- `chat` → (direct to embedding/LLM) ✓

### Parser → Preprocessor
- `parse` (text) → `preprocessor_*` ✓
- `ocr` (text) → `preprocessor_*` ✓

### Preprocessor → Embedding
- `preprocessor_*` (documents) → `embedding_*` ✓

### Embedding → Vector DB
- `embedding_*` (documents) → Any vector DB ✓
- `embedding_*` (questions) → Any vector DB ✓

### Vector DB → LLM
- Vector DB (questions) → Any LLM ✓

### LLM → Output
- Any LLM (answers) → `response` ✓

---

## Quick Reference

### Most Common Components

**Basic Pipeline:**
1. `webhook` - Input
2. `parse` - Extract content
3. `response` - Output

**RAG Pipeline:**
1. `chat` - Questions
2. `embedding_transformer` - Vectorize
3. `qdrant` - Search
4. `llm_openai` - Answer
5. `response` - Output

**Document Indexing:**
1. `webhook` - Upload
2. `parse` - Extract
3. `preprocessor_langchain` - Chunk
4. `embedding_transformer` - Vectorize
5. `qdrant` - Store

---

**Total Components Documented:** 60+

For pipeline building rules and best practices, see **ROCKETRIDE_PIPELINE_RULES.md**

