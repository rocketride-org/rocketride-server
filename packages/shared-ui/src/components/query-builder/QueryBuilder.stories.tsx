// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import type { Meta, StoryObj } from '@storybook/react';
import QueryBuilder, { IProps } from './QueryBuilder';
import { IQueryBuilderConfig, IQueryBuilderOperators, IQueryBuilderUnits } from './types';
import { useQueryBuilder } from './useQueryBuilder';

/**
 * Props for the Storybook template wrapper component.
 */
interface ITemplateProps {
	/** The QueryBuilder component props forwarded from the Storybook args. */
	args: IProps;
}

/** Storybook metadata for the QueryBuilder component, registering it for auto-discovery. */
const meta: Meta<typeof QueryBuilder> = {
	component: QueryBuilder,
};

export default meta;

/** Type alias for a single QueryBuilder story object, used for type-safe story definitions. */
type Story = StoryObj<typeof QueryBuilder>;

/**
 * Storybook template component that wraps QueryBuilder with sample configuration data.
 * Sets up operators (string, number, date), units (size), and a multi-category config
 * tree so the QueryBuilder can be interactively tested in Storybook.
 *
 * @param props - Template props containing forwarded QueryBuilder args.
 * @returns A fully configured QueryBuilder instance for interactive Storybook use.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const Template = ({ args }: ITemplateProps) => {
	const operators: IQueryBuilderOperators = {
		string: [
			{ label: 'Equal', value: 'equal', type: 'string' },
			{ label: 'Not Equal', value: 'notEqual', type: 'string' },
		],

		number: [
			{ label: 'Greater Than', value: 'greaterThan', type: 'number' },
			{ label: 'Less Than', value: 'lessThan', type: 'number' },
		],

		date: [
			{ label: 'On', value: 'on', type: 'date' },
			{ label: 'Not On', value: 'noton', type: 'date' },
			{ label: 'Between', value: 'between', type: 'dateRange' },
		],
	};

	const units: IQueryBuilderUnits = {
		size: [
			{ label: 'Bytes', value: 'bytes' },
			{ label: 'KB', value: 'kb' },
			{ label: 'MB', value: 'mb' },
			{ label: 'GB', value: 'gb' },
			{ label: 'TB', value: 'tb' },
			{ label: 'PB', value: 'pb' },
			{ label: 'EB', value: 'eb' },
		],
	};

	const config: IQueryBuilderConfig[] = [
		{
			key: 'file',
			label: 'File',
			items: [
				{
					key: 'fileName',
					label: 'Name',
					value: { select: 'file', column: 'name' },
					valueLabel: 'File Name',
					type: 'string',
					operator: operators.string,
				},
				{
					key: 'fileVersion',
					label: 'Version',
					value: { select: 'file', column: 'version' },
					valueLabel: 'File Version',
					type: 'number',
					operator: operators.number,
				},
				{
					key: 'fileDeleted',
					label: 'Deleted',
					value: { select: 'file', column: 'isDeleted' },
					valueLabel: 'File Deleted',
					type: 'boolean',
				},
			],
		},
		{
			key: 'path',
			label: 'Path',
			items: [
				{
					key: 'pathLocalPath',
					label: 'Local Path',
					value: { select: 'path', column: 'localPath' },
					valueLabel: 'Local Path',
					type: 'string',
					operator: operators.string,
				},
				{
					key: 'pathParentPath',
					label: 'Parent Path',
					value: { select: 'path', column: 'parentPath' },
					valueLabel: 'Parent Path',
					type: 'string',
					operator: operators.string,
				},
			],
		},
		{
			key: 'size',
			label: 'Size',
			items: [
				{
					key: 'sizeSize',
					label: 'Size',
					value: { select: 'size', column: 'size' },
					valueLabel: 'Size',
					type: 'string',
					operator: operators.string,
					unit: units.size,
				},
				{
					key: 'sizeOnDisk',
					label: 'Size On Disk',
					value: { select: 'size', column: 'sizeOnDisk' },
					valueLabel: 'Size On Disk',
					type: 'string',
					operator: operators.string,
					unit: units.size,
				},
			],
		},
		{
			key: 'date',
			label: 'Date',
			items: [
				{
					key: 'dateCreated',
					label: 'Date Created',
					value: { select: 'date', column: 'created' },
					valueLabel: 'Date Created',
					type: 'date',
					operator: operators.date,
				},
			],
		},
		{
			key: 'content',
			label: 'Content',
			value: { select: 'content', column: 'content' },
			valueLabel: 'Content',
			type: 'string',
			operator: operators.string,
		},
		{
			key: 'select',
			label: 'Select',
			value: { select: 'select', column: 'select' },
			valueLabel: 'Select',
			type: 'string',
			operator: operators.string,
		},
	];

	const { queryData, onChange } = useQueryBuilder();

	return (
		<QueryBuilder addLabel={'Add Query'} config={config} data={queryData} onChange={onChange} />
	);
};

/** Primary story showcasing the QueryBuilder with a full-screen layout and sample configuration. */
export const Primary: Story = {
	name: 'Components/QueryBuilder',
	render: (args) => <Template args={args} />,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {},
	argTypes: {},
};
