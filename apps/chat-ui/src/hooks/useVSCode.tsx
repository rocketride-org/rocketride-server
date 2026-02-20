/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
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
