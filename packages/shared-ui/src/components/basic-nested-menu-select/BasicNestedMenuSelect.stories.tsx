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
import { useState } from 'react';
import BasicNestedMenuSelect, { IProps } from './BasicNestedMenuSelect';
import { IMenuItem } from '../basic-nested-menu/BasicNestedMenu';

/**
 * Props passed to the story template wrapper component.
 * Wraps the Storybook args so they can be forwarded to BasicNestedMenuSelect.
 */
interface ITemplateProps {
	args: IProps;
}

/**
 * Storybook metadata for the BasicNestedMenuSelect component.
 * Registers the component with Storybook's catalog for documentation and visual testing.
 */
const meta: Meta<typeof BasicNestedMenuSelect> = {
	component: BasicNestedMenuSelect,
};

export default meta;

/** Storybook Story type alias scoped to BasicNestedMenuSelect for type-safe story definitions. */
type Story = StoryObj<typeof BasicNestedMenuSelect>;

/**
 * Interactive template component that wraps BasicNestedMenuSelect for Storybook.
 * Manages selection state and provides sample nested menu items with multiple
 * hierarchy levels to demonstrate the select-with-nested-menu behaviour.
 *
 * @param props - Contains the Storybook args to spread onto BasicNestedMenuSelect.
 * @returns A BasicNestedMenuSelect with sample hierarchical items.
 */
const Template = ({ args }: ITemplateProps) => {
	const [key, setKey] = useState('');
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const [value, setValue] = useState('');

	/** Handles menu item selection by updating both key and value state. */
	const onChange = (key: string, value: unknown) => {
		setKey(key);
		setValue(value as string);
	};

	/** Sample nested menu items demonstrating a three-level hierarchy for the story. */
	const items: IMenuItem[] = [
		{
			key: 'itemOne',
			label: 'Item One',
			valueLabel: 'Item One',
			value: 'Item One',
		},
		{
			key: 'subMenuOne',
			label: 'Sub Menu One',
			items: [
				{
					key: 'subMenuOneItemOne',
					label: 'Sub Menu One Sub Item One',
					value: { value: 'Sub Item One' },
					valueLabel: 'Sub Menu One Sub Item One',
				},
				{
					key: 'subMenuTwo',
					label: 'Sub Menu Two',
					items: [
						{
							key: 'subMenuTwoSubItemOne',
							label: 'Sub Item One',
							value: { value: 'Sub Menu Two Sub Item One' },
							valueLabel: 'Sub Menu Two Sub Item One',
						},
						{
							key: 'subMenuTwoSubItemTwo',
							label: 'Sub Item Two',
							value: { value: 'Sub Menu Two Sub Item Two' },
							valueLabel: 'Sub Menu Two Sub Item Two',
						},
					],
				},
			],
		},
	];

	return (
		<>
			<BasicNestedMenuSelect
				{...args}
				label="Select"
				keyValue={key}
				items={items}
				onChange={onChange}
			/>
		</>
	);
};

/** Primary story showcasing BasicNestedMenuSelect with multi-level items inside a select field. */
export const Primary: Story = {
	name: 'Components/BasicNestedMenuSelect',
	render: (args) => <Template args={args} />,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {},
	argTypes: {},
};
