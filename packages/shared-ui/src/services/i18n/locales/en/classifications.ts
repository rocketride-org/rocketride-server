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
 * Type definition for the "classifications" translation namespace.
 * Describes all translatable strings for custom and predefined classification
 * management, including the rule builder, wizard steps, snackbar messages,
 * and text-filtering options.
 */
export interface ITranslationClassifications {
	titlePrefix: string;
	panel: {
		createHeader: string;
		operators: string;
		contentSearch: string;
		predefinedRules: string;
		searchPlaceholder?: string;
	};
	button: {
		create: string;
	};
	customClassifications: {
		singular: string;
		plural: string;
	};
	predefinedClassifications: {
		singular: string;
		plural: string;
	};
	predefinedRule: {
		label: string;
		count: string;
		uniqueCount: string;
		saveRule: string;
	};
	keyword: {
		addAnother: string;
		count: string;
		uniqueCount: string;
		saveRule: string;
		keywords: string;
	};
	view: string;
	rename: string;
	delete: string;
	regex: {
		label: string;
		validating: string;
		count: string;
		uniqueCount: string;
		saveRule: string;
		validationError: string;
	};
	minMax: {
		comparisonType: string;
		options: {
			between: string;
			lessthan: string;
			morethan: string;
		};
		value: string;
		from: string;
		to: string;
	};
	confidence: string;
	searchItems: {
		and: {
			label: string;
			description: string;
		};
		or: {
			label: string;
			description: string;
		};
		not: {
			label: string;
			description: string;
		};
		regex: {
			label: string;
			description: string;
		};
		keyword: {
			label: string;
			description: string;
		};
	};
	wizard: {
		step1: {
			subheader: string;
			description: string;
		};
		step2: {
			subheader: string;
			description: string;
		};
		step3: {
			subheader: string;
			description: string;
		};
		step4: {
			subheader: string;
			description: string;
		};
		step5: {
			subheader: string;
			description: string;
		};
	};
	snackbar: {
		saveSuccess: string;
		noName: string;
		ruleSaved: string;
		saveError: string;
		deleteError: string;
	};
	tooltips: {
		delete: string;
	};
	error: {
		countValidation: string;
	};
	filterTextBy: string;
	filterTextMatch: string;
	filterTextNoMatch: string;
	filterTextWarning: string;
	filterTextNoFilter: string;
}

/** English translations for the "classifications" namespace covering data classification UI. */
export const classifications: ITranslationClassifications = {
	titlePrefix: 'Custom Classification',
	panel: {
		createHeader: 'Select a Rule',
		operators: 'Operators',
		contentSearch: 'Content Search',
		predefinedRules: 'Predefined Rules',
		searchPlaceholder: 'Search rules',
	},
	button: {
		create: 'Create Custom Classification',
	},
	customClassifications: {
		singular: 'Custom classification',
		plural: 'Custom classifications',
	},
	predefinedClassifications: {
		singular: 'Predefined Classifications',
		plural: 'Predefined Classifications',
	},
	predefinedRule: {
		label: 'Predefined Rules',
		count: 'Count',
		uniqueCount: 'Unique Count',
		saveRule: 'Save Rule',
	},
	keyword: {
		addAnother: 'Add Another Keyword',
		count: 'Count',
		uniqueCount: 'Unique Count',
		saveRule: 'Save Rule',
		keywords: 'Keywords',
	},
	view: 'View',
	rename: 'Rename',
	delete: 'Delete',
	regex: {
		label: 'Regex',
		validating: 'Validating....',
		count: 'Count',
		uniqueCount: 'Unique Count',
		saveRule: 'Save Rule',
		validationError: 'Regex invalid, please check your syntax and try again',
	},
	minMax: {
		comparisonType: 'Comparison Type',
		options: {
			between: 'Between',
			lessthan: 'Less than or Equal',
			morethan: 'More than or Equal',
		},
		value: 'Value',
		from: 'From',
		to: 'To',
	},
	confidence: 'Confidence',
	searchItems: {
		and: {
			label: 'And',
			description: 'Use this to require multiple criteria to be met at the same time.',
		},
		or: {
			label: 'Or',
			description: 'Use this to allow flexibility between multiple criteria.',
		},
		not: {
			label: 'Not',
			description: 'Use this to exclude matches or create opposite logic.',
		},
		regex: {
			label: 'Regex',
			description: 'Matches text using a regular expression pattern.',
		},
		keyword: {
			label: 'Keyword',
			description: 'Matches when the file contains specific keywords or phrases.',
		},
	},
	wizard: {
		step1: {
			subheader: 'Welcome',
			description:
				'Get started with our new feature. This guide will walk you through the key functionalities.',
		},
		step2: {
			subheader: 'Step 1: Connect Data',
			description: 'Connect your data sources seamlessly. We support various integrations.',
		},
		step3: {
			subheader: 'Step 2: Transform Data',
			description:
				'Transform and prepare your data with our easy-to-use tools and functions.',
		},
		step4: {
			subheader: 'Step 3: Store Results',
			description:
				'Store the processed results in your preferred database or data warehouse.',
		},
		step5: {
			subheader: 'Step 4: Explore Insights',
			description: 'All set to explore and gain valuable insights from your data!',
		},
	},
	snackbar: {
		noName: 'Please create a name for your custom classification',
		saveSuccess: 'Custom classification has saved',
		ruleSaved: 'Successfully updated rule',
		saveError: 'There was a problem saving your custom classification',
		deleteError: 'There was a problem deleting your custom classification',
	},
	tooltips: {
		delete: 'Delete Custom Classification',
	},
	error: {
		countValidation: 'Please provide a number 1 or higher',
	},
	filterTextBy: 'Filter out all text in files that',
	filterTextMatch: 'Match selected classifications',
	filterTextNoMatch: 'Do not match selected classifications',
	filterTextNoFilter: 'No filtering: Classify and pass all files through Text lane',
	filterTextWarning: 'The "Text" output lane must be connected in order to filter text.',
};
