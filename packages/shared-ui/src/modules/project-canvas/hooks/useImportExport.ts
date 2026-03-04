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
 * Hook providing import and export functionality for pipeline toolchains.
 *
 * Export serialises the current canvas to a JSON file, optionally stripping
 * sensitive data (API keys, secrets) via schema introspection and fuzzy matching.
 * Import merges or overwrites the current pipeline with components from a
 * previously exported JSON file.
 */
import { useState } from 'react';
import { useReactFlow, getNodesBounds, Node, Edge, Viewport, ReactFlowJsonObject } from '@xyflow/react';
import { objectToProperty, propertyToObject } from '../helpers';
import { IProject, IToolchainExport } from '../types';
import { getTimestampFormat } from '../../../utils/get-timestamp-format';
import {
	getFieldsLike,
	getPasswordFields,
	getSecuredFields,
	removeFieldValues,
} from '../../../utils/rjsf';
import { RJSFSchema, UiSchema } from '@rjsf/utils';
import { IDynamicForms, ISchema } from '../../../services/dynamic-forms/types';

/** User-configurable options for the export operation. */
export interface ExportOptions {
	includeSecureData: boolean;
}

/** Dependencies injected into the {@link useImportExport} hook from the parent FlowProvider. */
interface UseImportExportProps {
	nodes: Node[];
	project: IProject;
	servicesJson: IDynamicForms;
	setNodes: (nodes: Node[]) => void;
	setEdges: (edges: Edge[]) => void;
	setViewport: (viewport: Viewport, options?: { duration: number }) => void;
}

/**
 * Provides `importToolchain` and `exportToolchain` actions plus export-options state.
 *
 * Import merges or overwrites the current pipeline depending on whether imported
 * component IDs overlap with existing ones.  Export serialises the canvas to a
 * downloadable JSON file, optionally sanitising sensitive fields.
 *
 * @param props - Injected canvas state setters and project metadata.
 * @returns Import/export actions and export-options state.
 */
export const useImportExport = ({
	nodes,
	project,
	servicesJson,
	setNodes,
	setEdges,
	setViewport,
}: UseImportExportProps) => {
	const { toObject } = useReactFlow();

	const [exportOptions, setExportOptions] = useState<ExportOptions>({
		includeSecureData: false,
	});

	/**
	 * Imports pipeline components from an exported JSON payload.
	 * If any imported component ID collides with an existing one the entire
	 * pipeline is replaced; otherwise components are appended below the current graph.
	 */
	const importToolchain = async (data: IToolchainExport): Promise<void> => {
		const { components } = data;

		// Preserve existing project metadata for the merge
		const name = project?.name;
		const description = project?.description;
		const version = project?.version;

		// Serialise the current canvas state so we can compare with the import
		const flowObject = toObject();
		const currentProject = objectToProperty(flowObject, name, description, version);

		// Detect ID collisions: if any imported component shares an ID with an existing one,
		// we replace the entire pipeline rather than appending (avoids duplicate IDs).
		let shouldOverwrite = false;
		const currentComponents = currentProject?.components ?? [];
		const currentComponentsIdSet = new Set(currentComponents.map((c) => c.id));
		for (const c of components) {
			if (currentComponentsIdSet.has(c.id)) {
				shouldOverwrite = true;
				break;
			}
		}

		let newProject: IProject;

		if (shouldOverwrite) {
			// Full replacement: imported components become the new pipeline
			newProject = {
				...currentProject,
				components,
			};
		} else {
			// Append: shift imported components below the existing graph to avoid overlap
			const bounds = getNodesBounds(nodes);
			const deltaY = bounds.y + bounds.height + 20;

			const _components = components.map((c) => ({
				...c,
				ui: {
					...(c?.ui ?? {}),
					position: {
						...(c?.ui?.position ?? {}),
						y: (c?.ui?.position?.y ?? 0) + deltaY,
					},
				},
			}));

			newProject = {
				...currentProject,
				components: [...(currentProject?.components ?? []), ..._components],
			};
		}

		// Re-hydrate the merged project back into ReactFlow nodes, edges, and viewport
		const _object = propertyToObject(newProject, servicesJson);

		setNodes(_object.nodes);
		setEdges(_object.edges);
		setViewport(_object.viewport);
	};

	/**
	 * Serialises the current pipeline to a JSON file and triggers a browser download.
	 * When `exportOptions.includeSecureData` is false, sensitive fields (API keys,
	 * secrets, tokens) are redacted before export.
	 *
	 * @returns `true` on successful download.
	 */
	const exportToolchain = async (): Promise<boolean> => {
		if (!project) throw new Error('No project id available for export');

		// Optionally strip sensitive data (API keys, secrets) before serialisation
		const flowObject = !exportOptions.includeSecureData
			? sanitizePipeline(toObject())
			: toObject();

		const name = project?.name;
		const description = project?.description;
		const version = project?.version;

		// Convert the ReactFlow graph to the portable IProject format
		const property = objectToProperty(flowObject, name, description, version);
		const components = property?.components ?? [];

		// Build the export payload including a version marker for compatibility checking
		const data: IToolchainExport = {
			components,
			servicesVersion: version,
			id: project.project_id ?? '',
		};

		const json = JSON.stringify(data, null, 2);

		// Sanitise the project name for use as a filename (lowercase, hyphens, no special chars)
		const _projectName = (name ?? '')
			.toLowerCase()
			.trim()
			.replace(/\s+/g, '-')
			.replace(/[^a-z0-9-]/g, '')
			.replace(/-+/g, '-');

		// Trigger a browser download via a temporary <a> element
		const blob = new Blob([json], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		const timestamp = getTimestampFormat();
		link.download = `rocketride-project-export-${_projectName}-${timestamp}.json`;
		link.click();

		return true;
	};

	/**
	 * Deep-clones the flow object and redacts all sensitive field values.
	 * Sensitivity is determined by: (1) `ui:widget: "secure"` markers,
	 * (2) `ui:widget: "password"` markers, and (3) fuzzy field-name matching
	 * against a list of known sensitive keywords (api, key, token, secret, etc.).
	 */
	const sanitizePipeline = (_flowObject: ReactFlowJsonObject) => {
		// Deep clone to avoid mutating the live ReactFlow state
		const flowObject = JSON.parse(JSON.stringify(_flowObject));

		// --- Collect schema and uiSchema entries for every node that has a Pipe definition ---

		const schemaEntries = flowObject.nodes
			.filter((n: Node) => (n.data as { Pipe?: ISchema }).Pipe?.schema != null)
			.map((n: Node) => [n.id, (n.data as { Pipe?: ISchema }).Pipe?.schema]);

		const uiSchemaEntries = flowObject.nodes
			.filter((n: Node) => (n.data as { Pipe?: ISchema }).Pipe?.ui != null)
			.map((n: Node) => [n.id, (n.data as { Pipe?: ISchema }).Pipe?.ui]);

		// --- Strategy 1: fields explicitly marked as "secure" in the uiSchema ---

		const schemaSecureEntries = uiSchemaEntries
			.map(([id, ui]: [string, UiSchema]) => [id, getSecuredFields(ui)])
			.filter(([_id, fields]: [string, Set<string>]) => fields.size);

		// --- Strategy 2: fields explicitly marked as "password" in the uiSchema ---

		const schemaPasswordEntries = uiSchemaEntries
			.map(([id, ui]: [string, UiSchema]) => [id, getPasswordFields(ui)])
			.filter(([_id, fields]: [string, Set<string>]) => fields.size);

		// --- Strategy 3: fuzzy name matching against known sensitive keywords ---

		const fields = [
			'api',
			'key',
			'clientId',
			'access',
			'token',
			'secret',
			'email',
			'tenant',
			'secure',
			'secureParameters',
		];

		const schemaFuzzyEntries = schemaEntries
			.map(([id, schema]: [string, RJSFSchema]) => [id, getFieldsLike(schema, fields)])
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			.filter(([id, fields]: [string, Set<string>]) => fields.size);

		const uiSchemaFuzzyEntries = uiSchemaEntries
			.map(([id, ui]: [string, UiSchema]) => [id, getFieldsLike(ui, fields)])
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			.filter(([id, fields]: [string, Set<string>]) => fields.size);

		// --- Merge all strategies into a single per-node set of field names to redact ---

		const secureMap = new Map<string, Set<string>>(schemaSecureEntries);
		const passwordMap = new Map<string, Set<string>>(schemaPasswordEntries);
		const schemaFuzzyFieldMap = new Map<string, Set<string>>(schemaFuzzyEntries);
		const uiSchemaFuzzyFieldMap = new Map<string, Set<string>>(uiSchemaFuzzyEntries);

		// Union all node IDs that have at least one sensitive field from any strategy
		const combinedMap = new Map<string, Set<string>>();
		const allKeys = new Set([
			...Array.from(secureMap.keys()),
			...Array.from(passwordMap.keys()),
			...Array.from(schemaFuzzyFieldMap.keys()),
			...Array.from(uiSchemaFuzzyFieldMap.keys()),
		]);
		for (const key of Array.from(allKeys)) {
			const secureSet = secureMap.get(key) ?? new Set();
			const passwordSet = passwordMap.get(key) ?? new Set();
			const schemaFuzzySet = schemaFuzzyFieldMap.get(key) ?? new Set();
			const uiSchemaFuzzySet = uiSchemaFuzzyFieldMap.get(key) ?? new Set();
			// Always include secureParameters as a top-level field to strip
			const combinedSet = new Set([
				'secureParameters',
				...Array.from(secureSet),
				...Array.from(passwordSet),
				...Array.from(schemaFuzzySet),
				...Array.from(uiSchemaFuzzySet),
			]);
			combinedMap.set(key, combinedSet);
		}

		// --- Walk every node and blank out the identified sensitive fields ---

		for (let i = 0; i < flowObject?.nodes.length; i++) {
			const node = flowObject.nodes[i];

			// Skip nodes with no sensitive fields identified
			if (!combinedMap.has(node.id)) continue;

			const formData = node.data?.formData ?? {};
			const formDataRedacted = removeFieldValues(formData, combinedMap.get(node.id)!);

			// Replace the formData with the redacted version and mark the node as invalid
			// because the user will need to re-enter the stripped values after import.
			flowObject.nodes[i].data.formData = formDataRedacted;
			flowObject.nodes[i].data.formDataValid = false;
		}

		return flowObject;
	};

	return {
		importToolchain,
		exportToolchain,
		exportOptions,
		setExportOptions,
	};
};
