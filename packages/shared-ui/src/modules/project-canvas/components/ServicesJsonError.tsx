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

import { FC } from 'react';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { Typography } from '@mui/material';
import { CSSProperties } from '@mui/styles';

/**
 * Props for the ServicesJsonError component.
 * Carries the error message or flag from a services.json configuration parse failure.
 */
interface ServicesJsonErrorProps {
	/** The error message string, a boolean flag, or undefined when there is no error. */
	error: string | boolean | undefined;
}

/**
 * Inline styles for the error overlay banner.
 * Centers the banner absolutely over the canvas with a red background.
 */
const styles: CSSProperties = {
	position: 'absolute',
	top: '50%',
	left: '50%',
	transform: 'translate(-50%, -50%)',
	backgroundColor: '#ff6b6b',
	padding: '15px 20px',
	borderRadius: '5px',
	color: 'white',
	fontWeight: 'bold',
	boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
	zIndex: 1000,
	display: 'flex',
	flexDirection: 'column',
	alignItems: 'center',
	maxWidth: '80%',
};

/**
 * Displays a prominent error overlay on the canvas when the services.json
 * configuration file contains errors. The banner is centered over the canvas
 * and renders null when no error is present.
 *
 * @param props - Contains the error message or flag from services.json parsing.
 * @returns The error overlay element, or null if there is no error.
 */
const ServicesJsonError: FC<ServicesJsonErrorProps> = ({ error }) => {
	// Render nothing when there is no error (falsy covers undefined, false, and empty string)
	if (!error) return null;
	return (
		<div style={styles}>
			<ErrorOutlineIcon style={{ marginRight: '10px' }} />
			<Typography>
				Services configuration error: <b>{String(error)}</b>.
			</Typography>
			<Typography>Please check your configuration and try again.</Typography>
		</div>
	);
};

export default ServicesJsonError;
