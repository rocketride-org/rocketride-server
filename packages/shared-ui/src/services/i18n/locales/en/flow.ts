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

/**
 * Type definition for the "flow" translation namespace.
 * Describes all translatable strings for the project canvas / flow editor,
 * including status indicators, success/error messages, panel labels, tooltips,
 * keyboard shortcuts, notification text, autosave UI, and first-time download prompts.
 */
export interface ITranslationFlow {
	addSource: string;
	status: {
		saving: string;
		running: string;
		pending: string;
		updated: string;
		unsaved: string;
		saved: string;
		new: string;
	};
	success: {
		running: string;
		saved: string;
		vectorize: {
			saved: string;
		};
	};
	errors: {
		running: string;
		saved: string;
		vectorize: {
			saved: string;
			unsaved: string;
		};
		servicesError: string;
		checkServices: string;
	};
	modals: {
		planInvalid: {
			title: string;
			subtitle: string;
			services: string;
			button1: string;
			button2: string;
		};
		planDowngradeWarning: {
			title: string;
			subtitle: string;
			services1: string;
			services2: string;
			button1: string;
			button2: string;
		};
	};
	panels: {
		node: {
			noForm: string;
			showAllCls: string;
			saveChanges: string;
			saving: string;
			validating: string;
			saveAndNext: string;
			saveAndRerun: string;
		};
		createNode: {
			header: string;
			curate: string;
			vectorize: string;
			documentation: string;
			planInvalid: string;
			planUpgrade: string;
		};
		headerTooltips: {
			source: string;
			embedding: string;
			llm: string;
			database: string;
			image: string;
			filter: string;
			preprocessor: string;
			other: string;
			audio: string;
			target: string;
			text: string;
			infrastructure: string;
			store: string;
			data: string;
		};
		importExport: {
			header: string;
			exportHeader: string;
			exportButton: string;
			importHeader: string;
			importButton: string;
			wrongFileType: string;
		};
	};
	tooltip: {
		history: string;
		delete: string;
		save: string;
		saveAs: string;
		run: string;
		stop: string;
		devMode: string;
		logs: string;
		addNode: string;
		importExport: string;
		wizard: string;
		hideWizard: string;
		showWizard: string;
		moreOptions: string;
		fitScreen: string;
		zoomIn: string;
		zoomOut: string;
		unlock: string;
		lock: string;
		createNote: string;
		undo: string;
		redo: string;
		rocketrideClientConnected: string;
		rocketrideClientDisconnected: string;
	};
	menu: {
		viewApiKey: string;
		delete: string;
	};
	annotationNode: {
		placeholder: string;
	};
	notification: {
		copyToClipboard: string;
		runSuccess: string;
		runError: string;
		authError: string;
		abortSuccess: string;
		abortError: string;
		insufficientTokenBalance: string;
		validationError: string;
		validationWarning: string;
		unsavedConnectors: string;
		planInvalidError: string;
	};
	laneMapping: {
		data: string;
	};
	shortcuts: {
		title: string;
		showTitle: string;
		hideTitle: string;
		navigate: string;
		arrowKeys: string;
		save: string;
		selectAll: string;
		delete: string;
		deleteKey: string;
		group: string;
		ungroup: string;
		toggleDevMode: string;
		runPipeline: string;
		search: string;
		searchPlaceholder: string;
		copy: string;
		paste: string;
		nodeTraversal: string;
		undo: string;
		redo: string;
		groups: {
			editing: string;
			selection: string;
			navigation: string;
			project: string;
		};
	};
	firstTimeDownload: {
		incomplete: {
			title: string;
			installing: string;
		};
		complete: {
			title: string;
			message: string;
		};
		error: {
			message: string;
		};
	};
	autosave: {
		autosave: string;
		save: string;
		saving: string;
		saved: string;
		cancel: string;
		saveAsModal: {
			title: string;
			projectNameLabel: string;
			projectNamePlaceholder: string;
			descriptionLabel: string;
			accept: string;
			descriptionPlaceholders: string[];
		};
	};
}

/** English translations for the "flow" namespace covering the project canvas and pipeline editor. */
export const flow: ITranslationFlow = {
	addSource: 'Start by selecting a data source',
	status: {
		saving: 'Saving...',
		running: 'Running...',
		pending: 'Pending...',
		updated: 'Updated',
		unsaved: 'Unsaved changes',
		saved: 'Saved',
		new: 'New',
	},
	success: {
		running: 'Project started.',
		saved: 'Project saved.',
		vectorize: {
			saved: 'Vector database saved.',
		},
	},
	errors: {
		running: 'Project failed to start.',
		saved: 'Project failed to save.',
		vectorize: {
			saved: 'Vector database failed to save.',
			unsaved: 'Vector database has unsaved changes.',
		},
		servicesError: 'Services configuration error',
		checkServices: 'Please check your configuration and try again.',
	},
	modals: {
		planInvalid: {
			title: 'Your current subscription does not support these components',
			subtitle: 'This pipeline will not run.',
			services: 'These connectors require the following plans:',
			button1: 'Reconfigure Pipeline',
			button2: 'Coming Soon: Upgrade Plan',
		},
		planDowngradeWarning: {
			title: '⚠️ Warning: Your enterprise subscription will end soon',
			subtitle: 'This pipeline will stop at the end of your billing cycle.',
			services1: 'These connectors require the following plans:',
			services2:
				'Please renew your plan or adjust these connectors before your billing cycle ends.',
			button1: 'Reconfigure Pipeline',
			button2: 'Run Pipeline',
		},
	},
	panels: {
		node: {
			noForm: 'No form available',
			showAllCls: 'Show all selected classifications',
			saveChanges: 'Save',
			saving: 'Saving...',
			validating: 'Validating...',
			saveAndNext: 'Save and go to next',
			saveAndRerun: 'Save and re-run',
		},
		createNode: {
			header: 'Add Node',
			curate: 'Curate your data (Optional)',
			vectorize: 'Vector Database',
			documentation: 'ROCKETRIDE Documentation:',
			planInvalid: 'Current subscription plan does not include this connector',
			planUpgrade: 'Coming Soon: Upgrade Subscription Plan',
		},
		headerTooltips: {
			source: 'Components that retrieve data from external systems, databases, and storage locations. These connectors serve as entry points for bringing data into your workflow from various origins like cloud storage, file systems, and enterprise applications.',
			embedding:
				'Components that convert text, images, or other data into vector representations. These tools transform content into numerical embeddings that capture semantic meaning, enabling similarity search, clustering, and other vector-based operations.',
			llm: ' Components that integrate with various AI language models for text generation and understanding. These connectors provide natural language processing capabilities including text generation, summarization, question answering, and content creation.',
			database:
				'Components that store, manage, and retrieve structured and vector data. These connectors provide persistent storage solutions for embeddings, metadata, and processed results, enabling efficient data management and retrieval.',
			image: ' Components that process, analyze, and transform visual content. These tools handle image-specific operations like OCR (text extraction), thumbnail generation, and visual content analysis.',
			filter: 'Components that process and transform data based on specific criteria. These tools modify, clean, or redact content, including operations like anonymization, content filtering, and data transformation.',
			preprocessor:
				'Components that prepare and optimize data for downstream processing. These connectors handle text chunking, normalization, formatting, and other preparation tasks to improve the quality of subsequent operations.',
			other: 'Utility components that provide specialized functionality not covered by other categories. These include workflow orchestration, response formatting, question management, and other supporting capabilities for complex data pipelines.',
			audio: 'Components that process, analyze, and transform audio content. These tools handle operations such as speech-to-text transcription, audio feature extraction, noise reduction, and audio content analysis, enabling workflows that require the understanding or manipulation of sound data.',
			target: 'Components that deliver or export data to external systems, destinations, or applications. These connectors serve as endpoints in your workflow, enabling the transfer, synchronization, or publishing of processed data to cloud storage, databases, APIs, or other target platforms.',
			text: 'Components that process, analyze, or transform textual data. These tools support operations such as text normalization, tokenization, language detection, sentiment analysis, and other tasks that enhance the understanding or manipulation of raw text content within workflows.',
			infrastructure:
				'Components that provide foundational services or capabilities required for workflow execution and system integration. These include tools for authentication, scheduling, monitoring, logging, and resource management, ensuring reliable and scalable operation of data pipelines and applications.',
			store: 'Components specialized in storing and searching high-dimensional vector embeddings. These connectors enable efficient similarity search, retrieval, and management of vectorized data representations—such as those generated by embedding models—supporting use cases like semantic search and nearest neighbor queries.',
			data: 'Components that store, manage, and retrieve structured or tabular data. These connectors provide persistent storage solutions for data such as records, tables, and metadata, supporting efficient querying, updating, and management of structured datasets.',
		},
		importExport: {
			header: 'Import / Export',
			exportHeader: 'Export',
			exportButton: 'Export Project',
			importHeader: 'Import',
			importButton: 'Import Project',
			wrongFileType: 'Please select a valid JSON file.',
		},
	},
	tooltip: {
		history: 'View Project Log',
		delete: 'Delete Project',
		save: 'Save',
		saveAs: 'Save As',
		run: 'Run Project',
		stop: 'Stop Pipeline',
		devMode: 'Developer mode',
		logs: 'View Logs',
		addNode: 'Add Node',
		importExport: 'Import / Export',
		wizard: 'Toggle Help Guide',
		hideWizard: 'Help Guide',
		showWizard: 'Show Help Guide',
		moreOptions: 'More Options',
		fitScreen: 'Fit to Screen',
		zoomIn: 'Zoom In',
		zoomOut: 'Zoom Out',
		unlock: 'Unlock',
		lock: 'Lock',
		createNote: 'Create a new note',
		undo: 'Undo',
		redo: 'Redo',
		rocketrideClientConnected: 'RocketRide Client is connected',
		rocketrideClientDisconnected: 'RocketRide Client is disconnected',
	},
	menu: {
		viewApiKey: 'Edit API key',
		delete: 'Delete project',
	},
	annotationNode: {
		placeholder: 'Double-click to edit...',
	},
	notification: {
		copyToClipboard: 'The URL was copied to the clipboard',
		runSuccess: 'Pipeline started successfully',
		runError: 'Pipeline failed to start',
		authError: 'Authentication failed. Please check your API key.',
		abortSuccess: 'Pipeline aborted successfully',
		abortError: 'Pipeline failed to abort',
		insufficientTokenBalance:
			'Your balance has insufficient tokens. Please check the "Usage" page.',
		validationError: 'Validation errors',
		validationWarning: 'Warning',
		unsavedConnectors: 'Pipeline start failed: Unsaved connectors.',
		planInvalidError: 'Pipeline start failed: Invalid plan for selected connectors.',
	},
	laneMapping: {
		data: 'data',
	},
	shortcuts: {
		title: 'Keyboard Shortcuts',
		navigate: 'Navigate Canvas',
		nodeTraversal: 'Node Traversal',
		showTitle: 'Show Keyboard Shortcuts',
		hideTitle: 'Hide Keyboard Shortcuts',
		arrowKeys: 'Arrow Keys',
		save: 'Save Project',
		selectAll: 'Select All Nodes',
		delete: 'Delete Selected',
		deleteKey: 'Del/Backspace',
		group: 'Group Selected',
		ungroup: 'Ungroup Selected',
		toggleDevMode: 'Toggle Dev Mode',
		runPipeline: 'Run Pipeline',
		search: 'Search',
		searchPlaceholder: 'Search nodes...',
		copy: 'Copy',
		paste: 'Paste',
		undo: 'Undo',
		redo: 'Redo',
		groups: {
			editing: 'Basic Editing',
			selection: 'Selection & Grouping',
			navigation: 'Navigation & Search',
			project: 'Project & Execution',
		},
	},
	firstTimeDownload: {
		incomplete: {
			title: 'Hang tight! Installing dependencies for',
			installing: 'Hang tight! Installing',
		},
		complete: {
			title: 'Dependencies are now installed',
			message: 'Next time you run this pipeline it should load much faster',
		},
		error: {
			message:
				'We ran into an issue installing some dependencies. Please try again or check your network connection.',
		},
	},
	autosave: {
		autosave: 'Autosave',
		save: 'Save',
		saving: 'Saving',
		saved: 'Saved',
		cancel: 'Cancel',
		saveAsModal: {
			title: 'Save As',
			projectNameLabel: 'Project Name',
			projectNamePlaceholder: 'Enter project name',
			descriptionLabel: 'Description',
			accept: 'Save changes',
			descriptionPlaceholders: [
				'Convince your future self this was a good idea...',
				"What's the story? Make it interesting.",
				'Sell me on this pipeline in one paragraph',
				'Why does this project deserve to exist?',
				'Future you will thank you for documenting this',
				'Give this pipeline some personality',
				'Make this sound cooler than it probably is',
				'What problem are we solving here? (Be honest)',
				"Explain this like I'm your curious colleague",
				'Add some context before you forget everything',
				'Document now, thank yourself later',
				'What makes this different from the other 47 pipelines?',
			],
		},
	},
};
