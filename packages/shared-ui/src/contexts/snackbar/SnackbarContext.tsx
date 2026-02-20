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

import {
	ReactElement,
	ReactNode,
	createContext,
	useContext,
	useState,
	useRef,
	useCallback,
	SyntheticEvent,
} from 'react';
import Snackbar, { SnackbarCloseReason } from '@mui/material/Snackbar';
import {
	Alert,
	Button,
	Dialog,
	DialogTitle,
	DialogActions,
	DialogContent,
	DialogContentText,
} from '@mui/material';

/**
 * Shape of the Snackbar context value, providing methods to show snackbar
 * notifications and confirmation dialogs from anywhere in the component tree.
 */
interface ISnackbarContext {
	/** Displays a snackbar notification with an optional alert type and auto-hide duration. */
	openSnackbar: (message: string, type?: string, duration?: number) => void;
	/** Programmatically closes the currently visible snackbar. */
	closeSnackbar: () => void;
	/** Opens a confirmation dialog with configurable title, message, and action buttons. */
	openDialog: (payload: IDialog) => void;
}

/**
 * React context that carries snackbar and dialog methods.
 * Consumed via the {@link useSnackbar} hook.
 */
const SnackbarContext = createContext<ISnackbarContext | null>(null);

/**
 * Configuration for a confirmation dialog opened via the snackbar context.
 * Defines the dialog title, body message, button labels, and an async
 * callback that runs when the user clicks the accept button.
 */
interface IDialog {
	/** Whether the dialog is currently open. */
	open: boolean;
	/** The dialog title text. */
	title?: string;
	/** The dialog body / description text. */
	message?: string;
	/** Label for the cancel button. */
	cancelText?: string;
	/** Label for the accept / confirm button. */
	acceptText?: string;
	/** Async callback invoked when the accept button is clicked. */
	acceptCallback?: () => Promise<void>;
}

/**
 * Props for the {@link SnackbarProvider} component.
 */
interface IProps {
	/** The child component tree that can consume the snackbar context. */
	children: ReactNode;
}

/**
 * Context provider that renders a MUI Snackbar and a confirmation Dialog,
 * exposing `openSnackbar`, `closeSnackbar`, and `openDialog` to the entire
 * subtree. Place this near the root of your app so all components can
 * trigger notifications and confirmations without prop drilling.
 */
export const SnackbarProvider = ({ children }: IProps): ReactElement => {
	// Snackbar display state: message content, alert severity type, auto-hide duration, and visibility
	const [message, setMessage] = useState<string | null>(null);
	const [duration, setDuration] = useState<number>(0);
	const [type, setType] = useState<string | null>(null);
	const [open, setOpen] = useState<boolean>(false);
	const [dialog, setDialog] = useState<IDialog>({
		open: false,
	});

	// Refs for dialog buttons to enable custom keyboard navigation (focus trapping)
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const acceptButtonRef = useRef<HTMLButtonElement>(null);

	const openSnackbar = (_message: string, _type?: string, _duration = 6000) => {
		// Set all snackbar properties and make it visible in a single batch
		setMessage(_message);
		setType(_type ?? null);
		setDuration(_duration);
		setOpen(true);
	};

	const closeSnackbar = () => {
		// Reset all snackbar state to defaults so the next open starts clean
		setOpen(false);
		setMessage('');
		setType(null);
		setDuration(0);
	};

	const handleClose = (_event: SyntheticEvent | globalThis.Event, reason?: SnackbarCloseReason) => {
		// Ignore clickaway so users don't accidentally dismiss important notifications
		if (reason === 'clickaway') {
			return;
		}
		closeSnackbar();
	};

	const openDialog = (payload: IDialog) => {
		// Force `open: true` regardless of what the caller passed to ensure the dialog is shown
		setDialog({
			...payload,
			open: true,
		});
	};

	const handleDialogAccept = async () => {
		if (!dialog?.acceptCallback) {
			return;
		}

		// Await the async callback so errors can be caught; close the dialog regardless of outcome
		try {
			await dialog.acceptCallback();
		} catch (error) {
			console.error(error);
		}

		setDialog({ open: false });
	};

	// Render the snackbar wrapped in an Alert component when a severity type is provided
	const renderAlertSnackbar = () => {
		return (
			<Snackbar open={open} autoHideDuration={duration} onClose={handleClose}>
				<Alert
					onClose={handleClose}
					severity={type as 'success' | 'error' | 'warning' | 'info'}
					variant="filled"
					sx={{ width: '100%' }}
				>
					{message}
				</Alert>
			</Snackbar>
		);
	};

	// Render a plain text snackbar without an Alert wrapper (no colored severity indicator)
	const renderSnackbar = () => {
		return (
			<Snackbar
				open={open}
				onClose={handleClose}
				autoHideDuration={duration}
				message={message}
			/>
		);
	};

	// Custom keyboard handler for the confirmation dialog to trap focus between
	// the cancel and accept buttons, providing accessible navigation.
	const handleDialogKeyDown = useCallback((event: React.KeyboardEvent) => {
		// Collect only the buttons that are actually rendered (filter out null refs)
		const buttons = [cancelButtonRef.current, acceptButtonRef.current].filter(
			Boolean
		) as HTMLButtonElement[];

		if (buttons.length === 0) return;

		if (event.key === 'Enter') {
			event.preventDefault();
			// Click the currently focused button, or fall back to the first button
			const focusedIndex = buttons.findIndex((btn) => btn === document.activeElement);
			if (focusedIndex !== -1) {
				buttons[focusedIndex]?.click();
			} else {
				buttons[0]?.click();
			}
			return;
		}

		// Implement circular Tab focus trapping within the dialog's action buttons
		if (event.key === 'Tab') {
			event.preventDefault();

			const currentIndex = buttons.findIndex((btn) => btn === document.activeElement);

			if (event.shiftKey) {
				// Shift+Tab: go backwards, wrapping to last button if at beginning
				const prevIndex = currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
				buttons[prevIndex]?.focus();
			} else {
				// Tab: go forwards, cycle back to first if at end
				const nextIndex =
					currentIndex === -1 || currentIndex >= buttons.length - 1
						? 0
						: currentIndex + 1;
				buttons[nextIndex]?.focus();
			}
		}
	}, []);

	const renderDialog = () => {
		return (
			<Dialog
				open={dialog.open}
				onClose={() => setDialog({ open: false })}
				onKeyDown={handleDialogKeyDown}
				disableRestoreFocus
			>
				<DialogTitle>{dialog.title}</DialogTitle>
				<DialogContent>
					<DialogContentText sx={{ whiteSpace: 'pre-line' }}>
						{dialog.message}
					</DialogContentText>
				</DialogContent>
				<DialogActions>
					<Button
						ref={cancelButtonRef}
						color="info"
						onClick={() => setDialog({ open: false })}
					>
						{dialog.cancelText}
					</Button>
					<Button ref={acceptButtonRef} color="error" onClick={handleDialogAccept}>
						{dialog.acceptText}
					</Button>
				</DialogActions>
			</Dialog>
		);
	};

	// Choose between the styled Alert snackbar or plain snackbar based on whether a type was provided
	const snackbar = type ? renderAlertSnackbar() : renderSnackbar();

	return (
		<SnackbarContext.Provider
			value={{
				openSnackbar,
				closeSnackbar,
				openDialog,
			}}
		>
			{renderDialog()}
			{snackbar}
			{children}
		</SnackbarContext.Provider>
	);
};

/**
 * Hook that provides access to the snackbar and dialog methods from the
 * nearest {@link SnackbarProvider}. Throws if called outside of a provider.
 *
 * @returns The snackbar context with `openSnackbar`, `closeSnackbar`, and `openDialog`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const useSnackbar = (): ISnackbarContext => {
	const ctx = useContext(SnackbarContext);
	// Fail-fast if the hook is used outside the provider tree to surface misconfiguration early
	if (!ctx) throw new Error('useSnackbar must be used within SnackbarProvider');
	return ctx;
};
