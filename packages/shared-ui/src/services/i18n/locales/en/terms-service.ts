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

/**
 * Type definition for the "terms-service" translation namespace.
 * Describes translatable strings for the Terms of Service agreement page,
 * including section titles and legal content for all contractual clauses.
 */
export interface ITranslationTermSerivce {
	title: string;
	intro: string;
	description: string;
	definitions: {
		title: string;
		software: string;
		licensee: string;
		licensor: string;
	};
	licenseGrant: {
		title: string;
		content: string;
	};
	licenseRestrictions: {
		title: string;
		intro: string;
		'restrictions.0': string;
		'restrictions.1': string;
		'restrictions.2': string;
	};
	ownership: {
		title: string;
		content: string;
	};
	termination: {
		title: string;
		content: string;
	};
	disclaimer: {
		title: string;
		content: string;
	};
	limitation: {
		title: string;
		content: string;
	};
	governingLaw: {
		title: string;
		content: string;
	};
	amendments: {
		title: string;
		content: string;
	};
	entireAgreement: {
		title: string;
		content: string;
	};
	close: string;
}

/** English translations for the "terms-service" namespace covering the Terms of Service page. */
export const termsService: ITranslationTermSerivce = {
	title: 'Terms of Service Agreement',
	intro: 'Please read the following terms and conditions carefully before proceeding. Your acceptance is required to access and use our services.',
	description:
		'A software license agreement is a legally binding contract between a software provider and the end user, outlining the terms under which the software can be used. For the RocketRide Platform, such an agreement would typically include the following sections:',
	definitions: {
		title: '1. Definitions',
		software:
			'"Software": Refers to the RocketRide Platform, including all associated components, features, and documentation.',
		licensee:
			'"Licensee": The individual or entity authorized to use the Software under this agreement.',
		licensor: '"Licensor": RocketRide, Inc., the owner and provider of the Software.',
	},
	licenseGrant: {
		title: '2. License Grant',
		content:
			'The Licensor grants the Licensee a non-exclusive, non-transferable right to use the Software, subject to the terms specified herein.',
	},
	licenseRestrictions: {
		title: '3. License Restrictions',
		intro: 'The Licensee agrees not to:',
		'restrictions.0': 'Modify, reverse-engineer, or decompile the Software.',
		'restrictions.1': 'Distribute or sublicense the Software to third parties.',
		'restrictions.2': 'Use the Software beyond the agreed-upon scope or number of users.',
	},
	ownership: {
		title: '4. Ownership and Intellectual Property',
		content:
			'All rights, titles, and interests in the Software, including intellectual property rights, are and shall remain with the Licensor. The Licensee acquires no rights in the Software other than those expressly granted in this agreement.',
	},
	termination: {
		title: '5. Term and Termination',
		content:
			'This agreement is effective until terminated by either party. The Licensee may terminate it at any time by ceasing to use the Software and deleting all copies. The Licensor may terminate it for any reason with notice to the Licensee. Upon termination, the Licensee must uninstall and destroy all copies of the Software.',
	},
	disclaimer: {
		title: '6. Disclaimer of Warranty',
		content:
			'The Software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. The Licensor does not warrant that the Software will be error-free or uninterrupted.',
	},
	limitation: {
		title: '7. Limitation of Liability',
		content:
			'In no event shall the Licensor be liable for any indirect, incidental, special, or consequential damages, including but not limited to loss of profits, data, or use, arising out of or in connection with this agreement or the use or inability to use the Software, even if the Licensor has been advised of the possibility of such damages.',
	},
	governingLaw: {
		title: '8. Governing Law',
		content:
			'This agreement shall be governed by and construed in accordance with the laws of the jurisdiction in which the Licensor is located, without regard to its conflict of law principles.',
	},
	amendments: {
		title: '9. Amendments',
		content:
			'The Licensor reserves the right to amend this agreement at any time. The Licensee will be notified of any amendments, and continued use of the Software constitutes acceptance of the amended terms.',
	},
	entireAgreement: {
		title: '10. Entire Agreement',
		content:
			'This agreement constitutes the entire agreement between the parties regarding the subject matter hereof and supersedes all prior or contemporaneous understandings or agreements, written or oral, regarding such subject matter.',
	},
	close: 'Close',
};
