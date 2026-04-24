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

import Grid from '@mui/material/Grid2';
import Box from '@mui/material/Box';
import { FormContextType, ObjectFieldTemplateProps, RJSFSchema, StrictRJSFSchema, canExpand, descriptionId, getTemplate, getUiOptions, titleId } from '@rjsf/utils';

// =============================================================================
// Component
// =============================================================================

/**
 * Custom RJSF template for rendering JSON Schema object fields as a vertical
 * MUI Grid layout. Displays the object's title and description headers,
 * renders each property as a full-width grid row with consistent spacing,
 * and optionally shows an "Add" button when the schema allows additional
 * properties. Supports a custom "hideRootTitle" UI option to suppress the
 * top-level object title.
 */
export default function ObjectFieldTemplate<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({ description, title, properties, required, disabled, readonly, uiSchema, idSchema, schema, formData, onAddClick, registry }: ObjectFieldTemplateProps<T, S, F>) {
	const uiOptions = getUiOptions<T, S, F>(uiSchema);
	// Allow consumers to suppress the root object title via a custom uiSchema option
	const hideRootTitle = !!(uiOptions as Record<string, unknown> | undefined)?.hideRootTitle;
	// Resolve title and description templates, which may be overridden per-field via uiSchema
	const TitleFieldTemplate = getTemplate<'TitleFieldTemplate', T, S, F>('TitleFieldTemplate', registry, uiOptions);

	const DescriptionFieldTemplate = getTemplate<'DescriptionFieldTemplate', T, S, F>('DescriptionFieldTemplate', registry, uiOptions);
	// Button templates are not overridden in the uiSchema
	const {
		ButtonTemplates: { AddButton },
	} = registry.templates;

	return (
		<>
			{((title && !hideRootTitle) || description) && (
				<Box sx={{ mb: 0.5 }}>
					{title && !hideRootTitle && <TitleFieldTemplate id={titleId<T>(idSchema)} title={title} required={required} schema={schema} uiSchema={uiSchema} registry={registry} />}
					{description && <DescriptionFieldTemplate id={descriptionId<T>(idSchema)} description={description} schema={schema} uiSchema={uiSchema} registry={registry} />}
				</Box>
			)}
			<Grid container direction="row" spacing={0}>
				{properties.map((element, index) =>
					// Remove the <Grid> if the inner element is hidden as the <Grid>
					// itself would otherwise still take up space.
					element.hidden ? (
						element.content
					) : (
						<Grid size={{ xs: 12 }} key={index} sx={{ marginBottom: '4px', marginTop: '8px' }}>
							{element.content}
						</Grid>
					)
				)}
				{canExpand<T, S, F>(schema, uiSchema, formData) && (
					<Grid container justifyContent="flex-end">
						<Grid>
							<AddButton className="object-property-expand" onClick={onAddClick(schema)} disabled={disabled || readonly} uiSchema={uiSchema} registry={registry} />
						</Grid>
					</Grid>
				)}
			</Grid>
		</>
	);
}
