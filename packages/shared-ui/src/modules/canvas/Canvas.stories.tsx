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
 * Storybook stories for the top-level Canvas module.
 * Provides mock project data and services JSON so the canvas can be previewed
 * in isolation within the Storybook environment.
 */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Canvas from './index';
import {
	IProject,
	IProjectComponent,
	IValidateResponse,
} from '../project-canvas/types';
import { IDynamicForms } from '../../services/dynamic-forms/types';

/** Default OAuth2 root URL for stories; passed in as oauth2RootUrl prop. */
const DEFAULT_OAUTH2_ROOT_URL = 'https://oauth2.rocketride.ai';

/** Minimal mock project used as the initial state for stories. */
const mockProject: IProject = {
	pipeline: { project_id: 'story-project', name: 'Story', components: [] },
};

/**
 * Mock services JSON containing a small subset of connector definitions (chat, llm_gemini, response).
 * Provides enough structure for the canvas to render the create-node panel and node forms.
 */
const mockServicesJson: IDynamicForms = {
	chat: {
		actions: 0,
		capabilities: 2560,
		classType: ['source'],
		description:
			'A user interface component that provides a web-based chat experience. It \ncreates its own HTTP endpoint, configured by host and port, to serve a simple \nchat UI. Users can interact with the interface to submit questions, which \nare routed through the attached pipeline for processing. Designed for easy \nintegration, it enables the addition of conversational capabilities to any \npipeline workflow.',
		documentation: 'https://bit.ly/4kWcpBI',
		icon: 'chat.svg',
		input: [
			{
				lane: '_source',
				output: [
					{
						description: 'Produces questions to be answered by the pipeline.',
						lane: 'questions',
					},
				],
			},
		],
		lanes: {
			_source: ['questions'],
		},
		Pipe: {
			schema: {
				properties: {
					hideForm: {
						default: true,
						type: 'boolean',
					},
					mode: {
						default: 'Source',
						type: 'string',
					},
					parameters: {
						type: 'object',
					},
					type: {
						default: 'chat',
						type: 'string',
					},
				},
				required: ['hideForm', 'type', 'mode'],
				title: 'Chat',
				type: 'object',
			},
			ui: {
				hideForm: {
					'ui:options': {
						label: false,
					},
					'ui:widget': 'hidden',
				},
				mode: {
					'ui:options': {
						label: false,
					},
					'ui:widget': 'hidden',
				},
				parameters: {
					'ui:options': {
						label: false,
					},
				},
				type: {
					'ui:options': {
						label: false,
					},
					'ui:widget': 'hidden',
				},
				'ui:order': ['hideForm', 'type', 'mode', 'parameters'],
			},
		},
		prefix: 'Chat',
		protocol: 'chat://',
		tile: [],
		title: 'Chat',
	},
	llm_gemini: {
		actions: 0,
		capabilities: 3072,
		classType: ['llm'],
		description:
			'A component that connects to Gemini models for advanced natural language \nprocessing. It supports tasks such as text generation, summarization, question \nanswering, and chat-based interactions. With access to state-of-the-art language \nmodels like Gemini-2.0-pro, this component enables high-quality, context-aware responses and \ncreative text generation. Configurable with API keys and deployment options, it allows \nseamless integration into AI-driven workflows with scalable performance.',
		documentation: 'https://bit.ly/4kXP81X',
		icon: 'gemini.svg',
		input: [
			{
				lane: 'questions',
				output: [
					{
						lane: 'answers',
					},
				],
			},
		],
		lanes: {
			questions: ['answers'],
		},
		Pipe: {
			schema: {
				dependencies: {
					profile: {
						oneOf: [
							{
								properties: {
									custom: {
										object: 'custom',
										properties: {
											apikey: {
												description: 'Google AI Developer API key',
												title: 'API Key',
												type: 'string',
											},
											model: {
												description: 'Gemini model',
												title: 'Model',
												type: 'string',
											},
											modelTotalTokens: {
												description: 'Maximum number of input + output tokens',
												title: 'Total Tokens',
												type: 'number',
											},
											outputTokens: {
												description: 'Maximum number of output tokens',
												title: 'Output Tokens',
												type: 'number',
											},
										},
										required: ['model', 'modelTotalTokens', 'outputTokens', 'apikey'],
										type: 'object',
									},
									profile: {
										enum: ['custom'],
									},
								},
							},
							{
								properties: {
									'gemini-1_5-pro': {
										object: 'gemini-1_5-pro',
										properties: {
											apikey: {
												description: 'Google AI Developer API key',
												title: 'API Key',
												type: 'string',
											},
										},
										required: ['apikey'],
										type: 'object',
									},
									profile: {
										enum: ['gemini-1_5-pro'],
									},
								},
							},
							{
								properties: {
									'gemini-1_5-flash': {
										object: 'gemini-1_5-flash',
										properties: {
											apikey: {
												description: 'Google AI Developer API key',
												title: 'API Key',
												type: 'string',
											},
										},
										required: ['apikey'],
										type: 'object',
									},
									profile: {
										enum: ['gemini-1_5-flash'],
									},
								},
							},
							{
								properties: {
									'gemini-2_0-flash': {
										object: 'gemini-2_0-flash',
										properties: {
											apikey: {
												description: 'Google AI Developer API key',
												title: 'API Key',
												type: 'string',
											},
										},
										required: ['apikey'],
										type: 'object',
									},
									profile: {
										enum: ['gemini-2_0-flash'],
									},
								},
							},
							{
								properties: {
									'gemini-2_0-flash-lite': {
										object: 'gemini-2_0-flash-lite',
										properties: {
											apikey: {
												description: 'Google AI Developer API key',
												title: 'API Key',
												type: 'string',
											},
										},
										required: ['apikey'],
										type: 'object',
									},
									profile: {
										enum: ['gemini-2_0-flash-lite'],
									},
								},
							},
							{
								properties: {
									'gemini-2_5-pro-preview': {
										object: 'gemini-2_5-pro-preview',
										properties: {
											apikey: {
												description: 'Google AI Developer API key',
												title: 'API Key',
												type: 'string',
											},
										},
										required: ['apikey'],
										type: 'object',
									},
									profile: {
										enum: ['gemini-2_5-pro-preview'],
									},
								},
							},
							{
								properties: {
									'gemini-2_0-flash-preview-image': {
										object: 'gemini-2_0-flash-preview-image',
										properties: {
											apikey: {
												description: 'Google AI Developer API key',
												title: 'API Key',
												type: 'string',
											},
										},
										required: ['apikey'],
										type: 'object',
									},
									profile: {
										enum: ['gemini-2_0-flash-preview-image'],
									},
								},
							},
						],
					},
				},
				properties: {
					profile: {
						default: 'gemini-1_5-pro',
						description: 'Gemini LLM model',
						enum: [
							'gemini-1_5-flash',
							'gemini-1_5-pro',
							'gemini-2_0-flash',
							'gemini-2_0-flash-lite',
							'gemini-2_0-flash-preview-image',
							'gemini-2_5-pro-preview',
						],
						title: 'Model',
						type: 'string',
					},
				},
				required: ['profile'],
				title: 'LLM - Gemini',
				type: 'object',
			},
			ui: {
				custom: {
					apikey: {
						'ui:widget': 'ApiKeyWidget',
					},
					model: {},
					modelTotalTokens: {},
					outputTokens: {},
					'ui:options': {
						label: false,
						nonNestedDisplay: true,
					},
					'ui:order': ['model', 'modelTotalTokens', 'outputTokens', 'apikey'],
				},
				'gemini-1_5-flash': {
					apikey: {
						'ui:widget': 'ApiKeyWidget',
					},
					'ui:options': {
						label: false,
						nonNestedDisplay: true,
					},
					'ui:order': ['apikey'],
				},
				'gemini-1_5-pro': {
					apikey: {
						'ui:widget': 'ApiKeyWidget',
					},
					'ui:options': {
						label: false,
						nonNestedDisplay: true,
					},
					'ui:order': ['apikey'],
				},
				'gemini-2_0-flash': {
					apikey: {
						'ui:widget': 'ApiKeyWidget',
					},
					'ui:options': {
						label: false,
						nonNestedDisplay: true,
					},
					'ui:order': ['apikey'],
				},
				'gemini-2_0-flash-lite': {
					apikey: {
						'ui:widget': 'ApiKeyWidget',
					},
					'ui:options': {
						label: false,
						nonNestedDisplay: true,
					},
					'ui:order': ['apikey'],
				},
				'gemini-2_0-flash-preview-image': {
					apikey: {
						'ui:widget': 'ApiKeyWidget',
					},
					'ui:options': {
						label: false,
						nonNestedDisplay: true,
					},
					'ui:order': ['apikey'],
				},
				'gemini-2_5-pro-preview': {
					apikey: {
						'ui:widget': 'ApiKeyWidget',
					},
					'ui:options': {
						label: false,
						nonNestedDisplay: true,
					},
					'ui:order': ['apikey'],
				},
				profile: {
					'ui:enumNames': [null, null, null, null, null, null],
				},
				'ui:order': [
					'profile',
					'custom',
					'gemini-1_5-pro',
					'gemini-1_5-flash',
					'gemini-2_0-flash',
					'gemini-2_0-flash-lite',
					'gemini-2_5-pro-preview',
					'gemini-2_0-flash-preview-image',
				],
			},
		},
		prefix: 'llm',
		protocol: 'llm_gemini://',
		tile: ['Model: ${parameters.llm_gemini.profile}'],
		title: 'LLM - Gemini',
	},
	response: {
		actions: 0,
		capabilities: 2048,
		classType: ['infrastructure'],
		description:
			'A component that sends processed data back to the requesting client in JSON format. \nIt handles the response phase of the HTTP request-response cycle by returning the results  as a JSON object. This component ensures that data is transmitted efficiently and clearly to \nthe client, providing a standardized format for the response.',
		documentation: 'https://bit.ly/40zzdjd',
		icon: 'util-infrastructure.svg',
		input: [
			{
				lane: 'text',
				output: [],
			},
			{
				lane: 'table',
				output: [],
			},
			{
				lane: 'documents',
				output: [],
			},
			{
				lane: 'questions',
				output: [],
			},
			{
				lane: 'answers',
				output: [],
			},
			{
				lane: 'audio',
				output: [],
			},
			{
				lane: 'video',
				output: [],
			},
			{
				lane: 'image',
				output: [],
			},
		],
		lanes: {
			answers: [],
			audio: [],
			documents: [],
			image: [],
			questions: [],
			table: [],
			text: [],
			video: [],
		},
		Pipe: {
			schema: {
				properties: {
					lanes: {
						description:
							'Each lane maps pipeline data to a custom JSON key in the response. \nSelect the data type (text, documents, answers, etc.) for Lane Name, \nand enter a custom JSON key name (1-32 characters) for Result Key.',
						items: {
							properties: {
								laneId: {
									enum: [
										'answers',
										'audio',
										'documents',
										'image',
										'questions',
										'table',
										'text',
										'video',
									],
									title: 'Lane name',
									type: 'string',
								},
								laneName: {
									maxLength: 32,
									minLength: 1,
									title: 'Result key',
									type: 'string',
								},
							},
							required: ['laneId', 'laneName'],
							type: 'object',
						},
						minItems: 0,
						title: 'Lanes',
						type: 'array',
					},
				},
				required: ['lanes'],
				title: 'Response',
				type: 'object',
			},
			ui: {
				lanes: {
					items: {
						laneId: {
							'ui:enumNames': [
								'Answers',
								'Audio',
								'Documents',
								'Image',
								'Questions',
								'Table',
								'Text',
								'Video',
							],
						},
						laneName: {},
						'ui:order': ['laneId', 'laneName'],
					},
					'ui:options': {
						inline: true,
					},
					'ui:order': ['items'],
				},
				'ui:order': ['lanes'],
			},
		},
		prefix: 'response',
		protocol: 'response://',
		tile: [],
		title: 'HTTP Results',
	},
} as unknown as IDynamicForms;

/** Storybook meta configuration for the Canvas module. */
const meta: Meta<typeof Canvas> = {
	component: Canvas,
	title: 'Modules/Canvas',
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
};

export default meta;

/** Convenience alias for strongly-typed story objects. */
type Story = StoryObj<typeof Canvas>;

/**
 * Render function for the default Canvas story.
 * Maintains local project state so the canvas can save and reload data within Storybook.
 */
function DefaultRender() {
	const [projectData, setProjectData] = useState<IProject>(mockProject);

	return (
		<Canvas
			oauth2RootUrl={DEFAULT_OAUTH2_ROOT_URL}
			project={projectData}
			servicesJson={mockServicesJson}
			handleSaveProject={(project: IProject) => {
				setProjectData(project);
			}}
			handleRunPipeline={() => {}}
			handleValidatePipeline={async (
				pipeline: IProject
			): Promise<IValidateResponse> => {
				const component = pipeline.components?.[0] ?? ({} as IProjectComponent);
				return {
					status: 'success',
					data: {
						errors: [],
						warnings: [],
						component,
						pipeline,
					},
				};
			}}
		/>
	);
}

/** Default story that renders the full canvas with mock data. */
export const Default: Story = {
	render: () => <DefaultRender />,
};
