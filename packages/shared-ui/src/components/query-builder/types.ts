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
 * Represents a single row of data in the query builder.
 * Each instance corresponds to one filter condition the user has configured,
 * including which field is selected, what operator/unit to apply, and the user-entered value.
 */
export interface IQueryBuilderData {
	/** Unique identifier for this query row, used for drag-and-drop ordering and React keying. */
	id: string;
	/** The key that maps this row to its configuration entry in the flattened config lookup. */
	selectKey: string;
	/** The selected category or table name (e.g., "file", "path", "size"). */
	select: string;
	/** The specific column within the selected category (e.g., "name", "localPath"). */
	column: string;
	/** The comparison operator chosen by the user (e.g., "equal", "greaterThan"). */
	operator?: string;
	/** The measurement unit chosen by the user (e.g., "kb", "mb"), when applicable. */
	unit?: string;
	/** The filter value entered by the user; type varies depending on the field type. */
	value: unknown;
}

/**
 * Describes a single comparison operator available for a query builder field.
 * Operators determine how the user's value is compared against the data
 * (e.g., "Equal", "Greater Than", "Between").
 */
export interface IQueryBuilderOperator {
	/** Human-readable display label for the operator (e.g., "Greater Than"). */
	label: string;
	/** Programmatic value sent to the backend or used in filtering logic. */
	value: string;
	/** The input type this operator requires (e.g., "string", "number", "dateRange"). */
	type: string;
}

/**
 * Describes a single measurement unit option for a query builder field.
 * Units allow the user to qualify numeric values with a dimension (e.g., Bytes, KB, MB).
 */
export interface IQueryBuilderUnit {
	/** Human-readable display label for the unit (e.g., "MB"). */
	label: string;
	/** Programmatic value representing the unit (e.g., "mb"). */
	value: string;
}

/**
 * A dictionary that groups operators by their category key (e.g., "string", "number", "date").
 * Used in configuration to assign the correct set of operators to each query builder field.
 */
export interface IQueryBuilderOperators {
	[key: string]: IQueryBuilderOperator[];
}

/**
 * A dictionary that groups measurement units by their category key (e.g., "size").
 * Used in configuration to assign the correct set of units to each query builder field.
 */
export interface IQueryBuilderUnits {
	[key: string]: IQueryBuilderUnit[];
}

/**
 * Defines the configuration for a single field or category within the query builder.
 * Configurations form a tree structure: top-level entries are categories (with `items`)
 * and leaf entries are selectable fields (with `value`). This drives the nested menu
 * and determines which operators, units, and input types each field supports.
 */
export interface IQueryBuilderConfig {
	/** Unique key identifying this configuration node, used for lookups in the flat config map. */
	key: string;
	/** Display label shown in the menu or UI for this field/category. */
	label?: string;
	/** The value payload for leaf nodes, typically containing `select` and `column` identifiers. */
	value?: unknown;
	/** A human-readable label describing the value, used for display purposes. */
	valueLabel?: string;
	/** The input type for this field (e.g., "string", "number", "boolean", "date"). */
	type?: string;
	/** Enumerated options for select-type fields, providing a list of valid choices. */
	enum?: string[];
	/** Available comparison operators for this field. */
	operator?: IQueryBuilderOperator[];
	/** Available measurement units for this field. */
	unit?: IQueryBuilderUnit[];
	/** Child configuration nodes, forming a hierarchical menu structure. */
	items?: IQueryBuilderConfig[];
}

/**
 * A flattened dictionary of query builder configurations, keyed by each config's unique key.
 * Created from the hierarchical config tree for O(1) lookups when resolving field settings
 * during query row creation and updates.
 */
export interface IQueryBuilderConfigFlat {
	[key: string]: IQueryBuilderConfig;
}
