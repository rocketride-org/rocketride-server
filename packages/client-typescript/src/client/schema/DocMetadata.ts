/**
 * MIT License
 * 
 * Copyright (c) 2026 Aparavi Software AG
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Contains information about where a document chunk came from and its properties.
 * 
 * Every document returned from RocketRide operations includes metadata that tells you
 * about the source file, the chunk's position within that file, permissions,
 * and whether it's table data or regular text.
 */
export interface DocMetadata {
	/** Unique identifier for the source document in the RocketRide system. */
	objectId: string;

	/** Position of this chunk within the document (0, 1, 2, etc.). */
	chunkId: number;

	/** Identifier of the RocketRide node/server where this document is stored. */
	nodeId?: string;

	/** File path or name of the source document. This is what you would see in a file browser. */
	parent?: string;

	/** Permission level identifier that controls who can access this document. */
	permissionId?: number;

	/** True if the source document has been deleted but is still in search results. */
	isDeleted?: boolean;

	/** True if this chunk contains structured table data, False for regular text content. */
	isTable?: boolean;

	/** If isTable is True, this identifies which table within the document this data came from. */
	tableId?: number;

	/** Component ID or signature associated with the document processing. */
	signature?: string;

	/** Allow additional fields for extensibility */
	[key: string]: unknown;
}

export class DocMetadataHelper {
	/**
	 * Convert metadata to a dictionary for serialization or storage.
	 */
	static toDict(metadata: DocMetadata): Record<string, unknown> {
		const result: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(metadata)) {
			if (value !== undefined && value !== null) {
				result[key] = value;
			}
		}

		return result;
	}

	/**
	 * Create default metadata for a document processing instance.
	 */
	static defaultMetadata(pInstance: { instance: { currentObject: { objectId: string; path: string; permissionId: number; componentId: string } }; IEndpoint: { endpoint: { jobConfig: Record<string, unknown> } } }): DocMetadata {
		return {
			objectId: pInstance.instance.currentObject.objectId,
			chunkId: 0,
			nodeId: pInstance.IEndpoint.endpoint.jobConfig['nodeId'] as string,
			parent: pInstance.instance.currentObject.path,
			permissionId: pInstance.instance.currentObject.permissionId,
			signature: pInstance.instance.currentObject.componentId,
			isDeleted: false,
			isTable: false,
			tableId: 0,
		};
	}
}
