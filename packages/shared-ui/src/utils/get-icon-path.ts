// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import { isUrl } from './is-url';

// Import all connector icons
import amazonS3Icon from '../assets/nodes/amazon-s3.svg';
import anthropicIcon from '../assets/nodes/anthropic.svg';
import rocketrideIcon from '../assets/nodes/rocketride.svg';
import astradbIcon from '../assets/nodes/astra_db.svg';
import audioPlayerIcon from '../assets/nodes/audio-player.svg';
import audioTranscribeIcon from '../assets/nodes/audio-transcribe.svg';
import azureBlobIcon from '../assets/nodes/azure-blob.svg';
import bedrockIcon from '../assets/nodes/bedrock.svg';
import captivePortalIcon from '../assets/nodes/Captive portal.svg';
import chatIcon from '../assets/nodes/chat.svg';
import chromaIcon from '../assets/nodes/chroma.svg';
import classificationIcon from '../assets/nodes/classification.svg';
import confluenceIcon from '../assets/nodes/confluence.svg';
import crewaiIcon from '../assets/nodes/crewai.svg';
import deepseekIcon from '../assets/nodes/deepseek.svg';
import dictionaryIcon from '../assets/nodes/dictionary.svg';
import dropperIcon from '../assets/nodes/dropper.svg';
import embeddingImageIcon from '../assets/nodes/embedding-image.svg';
import embeddingOpenaiIcon from '../assets/nodes/embedding-openai.svg';
import embeddingTextIcon from '../assets/nodes/embedding-text.svg';
import elasticsearchIcon from '../assets/nodes/elasticsearch.svg';
import exaIcon from '../assets/nodes/exa.svg';
import fileSystemIcon from '../assets/nodes/file-system.svg';
import firecrawlIcon from '../assets/nodes/firecrawl.svg';
import frameGrabberIcon from '../assets/nodes/frame_grabber.svg';
import geminiIcon from '../assets/nodes/gemini.svg';
import gmailIcon from '../assets/nodes/gmail.svg';
import googleDriveIcon from '../assets/nodes/google-drive.svg';
import hashIcon from '../assets/nodes/hash.svg';
import ibmIcon from '../assets/nodes/ibm_granite.svg';
import imageCleanupIcon from '../assets/nodes/image_cleanup.svg';
import langchainIcon from '../assets/nodes/langchain.svg';
import llamaindexIcon from '../assets/nodes/llamaindex_icon.svg';
import llamaparseIcon from '../assets/nodes/llamaparse.svg';
import milvusIcon from '../assets/nodes/milvus.svg';
import mistralVisionIcon from '../assets/nodes/mistral-vision.svg';
import mistralIcon from '../assets/nodes/mistral.svg';
import mongoDBIcon from '../assets/nodes/mongodb.svg';
import mysqlIcon from '../assets/nodes/mysql.svg';
import objstoreIcon from '../assets/nodes/objstore.svg';
import ocrIcon from '../assets/nodes/ocr.svg';
import ollamaIcon from '../assets/nodes/ollama.svg';
import onedriveIcon from '../assets/nodes/onedrive.svg';
import openaiIcon from '../assets/nodes/openai.svg';
import opensearchIcon from '../assets/nodes/opensearch.svg';
import outlookIcon from '../assets/nodes/outlook.svg';
import parseIcon from '../assets/nodes/parse.svg';
import perplexityIcon from '../assets/nodes/perplexity.svg';
import pineconeIcon from '../assets/nodes/pinecone.svg';
import preprocessorIcon from '../assets/nodes/preprocessor.svg';
import preprocessorCodeIcon from '../assets/nodes/preprocessor-code.svg';
import preprocessorLlmIcon from '../assets/nodes/preprocessor-llm.svg';
import preprocessorTextIcon from '../assets/nodes/preprocessor-text.svg';
import postgresqlIcon from '../assets/nodes/postgres.svg';
import promptIcon from '../assets/nodes/Prompt.svg';
import qdrantIcon from '../assets/nodes/qdrant.svg';
import questionIcon from '../assets/nodes/question.svg';
import reductoIcon from '../assets/nodes/reducto.svg';
import sharepointIcon from '../assets/nodes/sharepoint.svg';
import smbIcon from '../assets/nodes/smb.svg';
import summariesIcon from '../assets/nodes/summaries.svg';
import textOutputIcon from '../assets/nodes/text-output.svg';
import thumbnailIcon from '../assets/nodes/thumbnail.svg';
import unknownIcon from '../assets/nodes/unknown.svg';
import utilInfrastructureIcon from '../assets/nodes/util-infrastructure.svg';
import utilTextIcon from '../assets/nodes/util-text.svg';
import vertexIcon from '../assets/nodes/vertex.svg';
import weaviateIcon from '../assets/nodes/weaviate.svg';
import webhookIcon from '../assets/nodes/webhook.svg';
import slackIcon from '../assets/nodes/slack.svg';
import pythonIcon from '../assets/nodes/python.svg';
import qwenIcon from '../assets/nodes/qwen.svg';
import chartjsIcon from '../assets/nodes/chartjs.svg';
import httpIcon from '../assets/nodes/http.svg';
import mcpIcon from '../assets/nodes/mcp.svg';
import memoryIcon from '../assets/nodes/memory.svg';
import xaiIcon from '../assets/nodes/xai.svg';

/**
 * Static lookup table mapping icon names (without file extensions) to their
 * bundled asset import paths. Used by {@link getIconPath} to resolve a
 * human-readable icon name to a Webpack/Vite-resolved asset URL.
 */
const iconMap: Record<string, string> = {
	'amazon-s3': amazonS3Icon,
	anthropic: anthropicIcon,
	rocketride: rocketrideIcon,
	astra_db: astradbIcon,
	'audio-player': audioPlayerIcon,
	'audio-transcribe': audioTranscribeIcon,
	'azure-blob': azureBlobIcon,
	bedrock: bedrockIcon,
	'Captive portal': captivePortalIcon,
	chat: chatIcon,
	chartjs: chartjsIcon,
	chroma: chromaIcon,
	classification: classificationIcon,
	confluence: confluenceIcon,
	crewai: crewaiIcon,
	deepseek: deepseekIcon,
	dictionary: dictionaryIcon,
	dropper: dropperIcon,
	elasticsearch: elasticsearchIcon,
	exa: exaIcon,
	'embedding-image': embeddingImageIcon,
	'embedding-openai': embeddingOpenaiIcon,
	'embedding-text': embeddingTextIcon,
	'file-system': fileSystemIcon,
	firecrawl: firecrawlIcon,
	frame_grabber: frameGrabberIcon,
	gemini: geminiIcon,
	gmail: gmailIcon,
	'google-drive': googleDriveIcon,
	hash: hashIcon,
	http: httpIcon,
	ibm_granite: ibmIcon,
	image_cleanup: imageCleanupIcon,
	langchain: langchainIcon,
	llamaindex_icon: llamaindexIcon,
	llamaparse: llamaparseIcon,
	mcp: mcpIcon,
	memory: memoryIcon,
	milvus: milvusIcon,
	'mistral-vision': mistralVisionIcon,
	mistral: mistralIcon,
	mongodb: mongoDBIcon,
	mysql: mysqlIcon,
	objstore: objstoreIcon,
	ocr: ocrIcon,
	ollama: ollamaIcon,
	onedrive: onedriveIcon,
	openai: openaiIcon,
	opensearch: opensearchIcon,
	outlook: outlookIcon,
	parse: parseIcon,
	perplexity: perplexityIcon,
	pinecone: pineconeIcon,
	postgres: postgresqlIcon,
	preprocessor: preprocessorIcon,
	'preprocessor-code': preprocessorCodeIcon,
	'preprocessor-llm': preprocessorLlmIcon,
	'preprocessor-text': preprocessorTextIcon,
	prompt: promptIcon,
	python: pythonIcon,
	qwen: qwenIcon,
	qdrant: qdrantIcon,
	question: questionIcon,
	reducto: reductoIcon,
	sharepoint: sharepointIcon,
	slack: slackIcon,
	smb: smbIcon,
	summaries: summariesIcon,
	'text-output': textOutputIcon,
	thumbnail: thumbnailIcon,
	unknown: unknownIcon,
	'util-infrastructure': utilInfrastructureIcon,
	'util-text': utilTextIcon,
	vertex: vertexIcon,
	weaviate: weaviateIcon,
	webhook: webhookIcon,
	xai: xaiIcon,
};

/**
 * Icons whose colour should adapt to the active theme.  On dark themes
 * they are rendered white; on light themes they stay dark.  The set
 * contains iconMap keys (i.e. filenames without extension).
 */
const THEME_DYNAMIC_ICONS: ReadonlySet<string> = new Set([
	// Source nodes
	'chat', 'dropper', 'webhook',
	// Embeddings
	'embedding-image', 'embedding-text',
	// LLMs
	'anthropic', 'ollama', 'openai', 'perplexity', 'xai',
	// Tools
	'http', 'mcp', 'memory',
	// Agents
	'langchain',
	// Database
	'mysql',
	// Image processing
	'frame_grabber', 'image_cleanup', 'ocr', 'thumbnail',
	// Preprocessors
	'preprocessor', 'preprocessor-code', 'preprocessor-llm', 'preprocessor-text',
	// Text nodes
	'util-text', 'dictionary', 'prompt', 'question', 'summaries', 'classification',
	// Audio
	'audio-transcribe',
	// Data
	'hash', 'parse',
	// Vector DB
	'pinecone',
	// Infrastructure
	'util-infrastructure', 'text-output',
]);

/**
 * Resolves a connector/service icon identifier to its bundled asset URL.
 * If the path is already a full URL it is returned as-is. If it matches
 * a known icon name (with or without file extension), the corresponding
 * bundled asset is returned. Falls back to the `unknown` icon.
 *
 * Theme-dynamic icons have {@code #td} appended so rendering components
 * can detect them and apply the appropriate CSS filter.
 *
 * @param path - An icon name (e.g., 'openai'), filename (e.g., 'openai.svg'), or full URL.
 * @returns The resolved asset URL string for use in `<img>` tags.
 */
export const getIconPath = (path?: string): string => {
	// No path provided; return the generic unknown icon as a safe default
	if (!path) {
		return unknownIcon;
	}

	// Already a full URL (e.g., from a remote service); use it directly
	if (isUrl(path)) {
		return path;
	}

	// Strip the file extension so the name matches the keys in iconMap
	const iconName = path.replace(/\.(svg|png|jpg|jpeg)$/i, '');

	// Look up the bundled asset; fall back to unknown icon if no match
	const resolved = iconMap[iconName] || unknownIcon;

	// Tag theme-dynamic icons so renderers can apply a colour filter
	return THEME_DYNAMIC_ICONS.has(iconName) ? `${resolved}#td` : resolved;
};
