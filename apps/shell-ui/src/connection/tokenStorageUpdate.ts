export interface TokenStorageUpdate {
	oldValue: string | null;
	newValue: string | null;
	currentUserToken?: string;
	hasAccountInfo: boolean;
}

export function shouldReloadForTokenStorageUpdate(update: TokenStorageUpdate): boolean {
	const { oldValue, newValue, currentUserToken, hasAccountInfo } = update;

	if (newValue === null) return false;

	if (oldValue !== null) {
		return currentUserToken !== newValue;
	}

	return !hasAccountInfo;
}
