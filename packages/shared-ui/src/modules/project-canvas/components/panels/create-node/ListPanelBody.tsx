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

import { ReactNode, useState } from 'react';
import { Box, SxProps } from '@mui/material';
import { useTranslation } from 'react-i18next';
import SearchField from '../../../../../components/inputs/search-field/SearchField';
import BasePanelContent from '../BasePanelContent';
import { brandOrange } from '../../../../../theme';
import { isInVSCode } from '../../../../../utils/vscode';
import CreateNodeFilter from './CreateNodeFilter';

/**
 * Props for the ListPanelBody component, which provides a searchable,
 * filterable container for list-based panel content.
 */
interface IProps {
	children: ReactNode;
	/** Active filter labels displayed as dismissible chips. */
	filters?: string[];
	/** Custom placeholder text for the search input. */
	searchPlaceholder?: string;
	/** Optional MUI sx overrides for the outer container. */
	sx?: SxProps;
	/** Optional MUI sx overrides for the search input. */
	searchFieldSx?: SxProps;
	/** Callback invoked when a filter chip's delete button is clicked. */
	onDeleteFilterCallback?: () => void;
	/** Callback invoked when the search field value changes. */
	onSearchCallback?: (value?: string) => void;
}

/**
 * Renders a searchable and filterable list body for side panels.
 * Includes a search input field at the top and optional filter chips
 * that allow users to narrow results. Used primarily by CreateNodePanel
 * to provide the search-and-filter UI above the scrollable node list.
 *
 * @param children - The scrollable list content (e.g. node groups).
 * @param filters - Active filter label strings.
 * @param searchPlaceholder - Search input placeholder override.
 * @param sx - Root container sx overrides.
 * @param searchFieldSx - Search field sx overrides.
 * @param onDeleteFilterCallback - Filter removal handler.
 * @param onSearchCallback - Search value change handler.
 */
export default function ListPanelBody({
	children,
	filters,
	searchPlaceholder,
	sx,
	searchFieldSx,
	onDeleteFilterCallback,
	onSearchCallback,
}: IProps): ReactNode {
	const [search, setSearch] = useState<string>('');
	const { t } = useTranslation();

	/**
	 * Updates local search state and notifies the parent via callback
	 * so that the filtered inventory can be recomputed.
	 */
	const handleSearch = (value?: string) => {
		// Keep local state in sync for the controlled input
		setSearch(value ?? '');
		// Propagate the value to the parent so it can recompute filtered results
		if (onSearchCallback) onSearchCallback(value);
	};

	const inVSCode = isInVSCode();

	return (
		<BasePanelContent sx={{ display: 'flex', flexDirection: 'column', ...sx }}>
			{filters && (
				<Box
					sx={{
						px: inVSCode ? '0.75rem' : '1rem',
						pt: inVSCode ? '0.25rem' : '1rem',
						pb: inVSCode ? '0.5rem' : '1rem',
						overflow: 'visible',
					}}
				>
					<SearchField
						value={search}
						placeholder={searchPlaceholder || t('form.searchNodeFieldPlaceholder')}
						onChange={(event) => handleSearch(event.target.value)}
						fullWidth
						sx={{ p: inVSCode ? '0.5rem 0.75rem' : '1rem', ...searchFieldSx }}
					/>
					{onDeleteFilterCallback && (
						<Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', mt: '0.5rem' }}>
							{filters.map((name: string) => (
								<CreateNodeFilter
									key={name}
									label={name}
									color={brandOrange}
									onDelete={onDeleteFilterCallback}
								/>
							))}
						</Box>
					)}
				</Box>
			)}
			{children}
		</BasePanelContent>
	);
}
