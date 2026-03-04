/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React, { createContext, useContext, ReactNode } from 'react';

interface VSCodeTheme {
	[key: string]: string;
}

export interface VSCodeContextType {
	isVSCode: boolean;
	isReady: boolean;
	theme: VSCodeTheme | null;
}

const VSCodeContext = createContext<VSCodeContextType | undefined>(undefined);

interface VSCodeProviderProps {
	children: ReactNode;
	value: VSCodeContextType;
}

export const VSCodeProvider: React.FC<VSCodeProviderProps> = ({ children, value }) => {
	return (
		<VSCodeContext.Provider value={value}>
			{children}
		</VSCodeContext.Provider>
	);
};

export const useVSCode = (): VSCodeContextType => {
	const context = useContext(VSCodeContext);
	if (context === undefined) {
		throw new Error('useVSCode must be used within a VSCodeProvider');
	}
	return context;
};
