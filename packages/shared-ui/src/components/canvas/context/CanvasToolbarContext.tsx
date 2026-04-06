import { createContext, useContext, useState, type ReactNode } from 'react';

const CanvasToolbarContext = createContext<{
	toolbar: ReactNode;
	setToolbar: (node: ReactNode) => void;
}>({ toolbar: null, setToolbar: () => {} });

export function CanvasToolbarProvider({ children }: { children: ReactNode }) {
	const [toolbar, setToolbar] = useState<ReactNode>(null);
	return <CanvasToolbarContext.Provider value={{ toolbar, setToolbar }}>{children}</CanvasToolbarContext.Provider>;
}

export function useCanvasToolbar() {
	return useContext(CanvasToolbarContext);
}
