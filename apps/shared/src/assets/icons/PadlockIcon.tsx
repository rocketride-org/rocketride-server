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

import { FunctionComponent } from 'react';
import { IIconProps } from './types';

/**
 * Two-tone filled padlock icon. Yellow body with dark shackle and keyhole.
 * Used to indicate a subscription-locked feature.
 *
 * @param props - Standard icon props for controlling size.
 */
const PadlockIcon: FunctionComponent<IIconProps> = ({ size }) => {
	const s = size ?? 24;
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width={s} height={s} viewBox="0 0 62 62">
			<circle cx="30.6" cy="32.4" r="25.8" fill="#ffd200" stroke="#c88f1e" strokeWidth="2" />
			<path fill="#fff" d="M30.212 15.639c-5.4.17-8.98 2.766-8.98 8.122v5.467h-1.216c-.892 0-1.62.614-1.62 1.383v14.37c0 .77.728 1.384 1.62 1.384h21.99c.892 0 1.598-.614 1.598-1.384V30.612c0-.77-.706-1.383-1.598-1.383h-1.238l.023-5.378c0-5.686-3.887-8.141-9.769-8.211-.274-.003-.544-.009-.81 0zm.54 3.593c.1-.003.213 0 .316 0 6.526 0 6.026 4.642 6.122 6.025v3.972H24.9v-3.95c-.023-1.372-.404-5.906 5.852-6.047z" />
		</svg>
	);
};

export default PadlockIcon;
