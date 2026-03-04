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
 * Type definition for the "api-keys" translation namespace.
 * Describes all translatable strings for the API key management page,
 * including CRUD operations, table headers, and status/error messages.
 */
export interface ITranslationApikeys {
	title: string;
	description: string;
	createNew: string;
	createApiKey: string;
	apiKeyName: string;
	apiKeyNamePlaceholder: string;
	create: string;
	cancel: string;
	delete: string;
	confirmDelete: string;
	confirmDeleteMessage: string;
	name: string;
	key: string;
	createdAt: string;
	lastUsed: string;
	status: string;
	active: string;
	inactive: string;
	actions: string;
	copyKey: string;
	keyCopied: string;
	noApiKeys: string;
	loadingError: string;
	createError: string;
	deleteError: string;
	deleteSuccess: string;
	createSuccess: string;
}

/** English translations for the "api-keys" namespace covering API key management UI. */
export const apikeys: ITranslationApikeys = {
	title: 'API Keys',
	description: 'Manage your API keys for accessing RocketRide services.',
	createNew: 'Create New API Key',
	createApiKey: 'Create API Key',
	apiKeyName: 'API Key Name',
	apiKeyNamePlaceholder: 'Enter a descriptive name for your API key',
	create: 'Create',
	cancel: 'Cancel',
	delete: 'Delete',
	confirmDelete: 'Confirm Delete',
	confirmDeleteMessage:
		'Are you sure you want to delete this API key? This action cannot be undone.',
	name: 'Name',
	key: 'Key',
	createdAt: 'Created',
	lastUsed: 'Last Used',
	status: 'Status',
	active: 'Active',
	inactive: 'Inactive',
	actions: 'Actions',
	copyKey: 'Copy Key',
	keyCopied: 'Key copied to clipboard',
	noApiKeys: 'No API keys found. Create your first API key to get started.',
	loadingError: 'Failed to load API keys. Please try again.',
	createError: 'Failed to create API key. Please try again.',
	deleteError: 'Failed to delete API key. Please try again.',
	deleteSuccess: 'API key deleted successfully.',
	createSuccess: 'API key created successfully.',
};
