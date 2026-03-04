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

import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from '@mui/material';
import BasicNestedMenu, { IMenuItem, IProps } from './BasicNestedMenu';

/**
 * Props passed to the story template wrapper component.
 * Wraps the Storybook args so they can be forwarded to BasicNestedMenu.
 */
interface ITemplateProps {
	args: IProps;
}

/**
 * Storybook metadata for the BasicNestedMenu component.
 * Registers the component with Storybook's catalog for documentation and visual testing.
 */
const meta: Meta<typeof BasicNestedMenu> = {
	component: BasicNestedMenu,
};

export default meta;

/** Storybook Story type alias scoped to BasicNestedMenu for type-safe story definitions. */
type Story = StoryObj<typeof BasicNestedMenu>;

/**
 * Interactive template component that wraps BasicNestedMenu for Storybook.
 * Manages the anchor element state, selected key/value, and provides sample
 * nested menu items to demonstrate multi-level menu behaviour.
 *
 * @param props - Contains the Storybook args to spread onto BasicNestedMenu.
 * @returns A button that opens a BasicNestedMenu when clicked.
 */
const Template = ({ args }: ITemplateProps) => {
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	/** Opens the menu by setting the anchor to the clicked button element. */
	const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
		setAnchorEl(event.currentTarget);
	};
	/** Closes the menu by clearing the anchor element. */
	const onClose = () => {
		setAnchorEl(null);
	};

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const [key, setKey] = useState('');
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const [value, setValue] = useState('');

	/** Handles menu item selection by updating both key and value state. */
	const onChange = (key: string, value: unknown) => {
		setKey(key);
		setValue(value as string);
	};

	/** Sample nested menu items demonstrating a two-level hierarchy for the story. */
	const items: IMenuItem[] = [
		{
			key: 'itemOne',
			label: 'Item One',
			value: 'Item One',
			valueLabel: 'Item One',
		},
		{
			key: 'menuOne',
			label: 'Menu One',
			items: [
				{
					key: 'menuOneItemOne',
					label: 'Menu One Item One ',
					value: 'Menu One Item One',
				},
				{
					key: 'menuOneSubMenuOne',
					label: 'Menu One Sub Menu One',
					items: [
						{
							key: 'subOneItemOne',
							label: 'Sub One Item One',
							value: 'Sub One Item One',
						},
						{
							key: 'subOneItemTwo',
							label: 'Sub One Item Two',
							value: 'Sub One Item Two',
						},
					],
				},
			],
		},
	];

	return (
		<>
			<Button onClick={onClick}>Open</Button>
			<BasicNestedMenu
				{...args}
				anchorEl={anchorEl as Element | null}
				items={items}
				onClose={onClose}
				onChange={onChange}
			/>
		</>
	);
};

/** Primary story showcasing the BasicNestedMenu with multi-level items and a trigger button. */
export const Primary: Story = {
	name: 'Components/BasicNestedMenu',
	render: (args) => <Template args={args} />,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {},
	argTypes: {},
};
