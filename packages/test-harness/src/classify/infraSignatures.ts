/**
 * Infra-failure signatures.
 *
 * When a pipeline error matches one of these, it's bucketed as
 * `infra_failure` (reported separately, not counted against pass/fail
 * totals). Anything else with an error is `logic_failure`.
 *
 * Keep this list narrow and add entries as new transient patterns appear.
 * Each entry should be specific enough that a literal node bug never
 * matches.
 */

export type InfraSignature = string | RegExp;

export const INFRA_SIGNATURES: InfraSignature[] = [
	'credit balance is too low',
	'rate_limit_error',
	'insufficient_quota',
	/429\s+Too Many Requests/i,
	'ECONNREFUSED',
	'ETIMEDOUT',
	'connection refused',
	'socket hang up',
	'getaddrinfo ENOTFOUND',
	'EAI_AGAIN',
	'Service Unavailable',
	/503\s+Service Unavailable/i,
];

export type ClassifiedInfra = {
	signature: string;
	rawError: string;
};

function matches(signature: InfraSignature, text: string): boolean {
	if (typeof signature === 'string') {
		return text.toLowerCase().includes(signature.toLowerCase());
	}
	return signature.test(text);
}

function signatureLabel(signature: InfraSignature): string {
	return typeof signature === 'string' ? signature : signature.source;
}

export function classifyError(errorText: string | undefined): ClassifiedInfra | null {
	if (!errorText) return null;
	for (const sig of INFRA_SIGNATURES) {
		if (matches(sig, errorText)) {
			return { signature: signatureLabel(sig), rawError: errorText };
		}
	}
	return null;
}
