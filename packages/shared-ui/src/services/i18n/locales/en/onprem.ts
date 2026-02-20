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
 * Type definition for the "onprem" translation namespace.
 * Describes translatable strings for on-premise authentication flows including
 * login, registration, forgot-password, reset-password, and email verification screens.
 */
export interface ITranslationOnprem {
	login: {
		title: string;
		subtitle: string;
		form: {
			email: string;
			password: string;
			submit: string;
			errors: {
				blankEmail: string;
				blankPassword: string;
				invalidEmail: string;
			};
		};
		createAccount: string;
		forgotPassword: string;
	};
	register: {
		title: string;
		subtitle: string;
		continueWithGithub: string;
		orDivider: string;
		form: {
			fullName: string;
			email: string;
			newPassword: string;
			confirmPassword: string;
			submit: string;
			errors: {
				passwordMismatch: string;
				blankUserName: string;
				blankEmail: string;
				blankPassword: string;
				invalidEmail: string;
			};
		};
		haveAccount: string;
	};
	forgotPassword: {
		title: string;
		subtitle: string;
		form: {
			email: string;
			submit: string;
			submitting: string;
			enterCode: string;
		};
		successMessage: string;
		back: string;
	};
	resetPassword: {
		title: string;
		subtitle: string;
		passwordSubtitle: string;
		form: {
			resetCode: string;
			newPassword: string;
			confirmPassword: string;
			submit: string;
			verifyCode: string;
			verifying: string;
			resetting: string;
			errors: {
				invalidCode: string;
				blankPassword: string;
				passwordMismatch: string;
			};
		};
		back: string;
	};
	verification: {
		title: string;
		subtitle: string;
		form: {
			verificationCode: string;
			submit: string;
		};
		resendCode: string;
		resending: string;
		logout: string;
	};
}

/** English translations for the "onprem" namespace covering on-premise authentication UI. */
export const onprem: ITranslationOnprem = {
	login: {
		title: 'Welcome Back',
		subtitle: 'Please log in to your account',
		form: {
			email: 'Account Email',
			password: 'Password',
			submit: 'Sign In',
			errors: {
				blankEmail: 'Email is required',
				blankPassword: 'Password is required',
				invalidEmail: 'Please enter a valid email address',
			},
		},
		createAccount: 'Create RocketRide Account',
		forgotPassword: 'Forgot your password?',
	},
	register: {
		title: 'Create Your Account',
		subtitle: 'Sign up with your email address to get started',
		continueWithGithub: 'Continue with GitHub',
		orDivider: 'or',
		form: {
			email: 'Account Email',
			fullName: 'Full Name',
			newPassword: 'Password',
			confirmPassword: 'Confirm Password',
			submit: 'Register',
			errors: {
				passwordMismatch: 'Passwords do not match',
				blankUserName: 'Full Name is required',
				blankEmail: 'Email is required',
				blankPassword: 'Password is required',
				invalidEmail: 'Please enter a valid email address',
			},
		},
		haveAccount: 'Already have an account?',
	},
	forgotPassword: {
		title: 'Reset Password',
		subtitle:
			'Please enter your email address. We will send you a 6-digit code to reset your password.',
		form: {
			email: 'Account Email',
			submit: 'Send Reset Code',
			submitting: 'Sending...',
			enterCode: 'Enter Reset Code',
		},
		successMessage:
			'If an account with that email exists, a password reset code has been sent to your email address.',
		back: 'Back to Login',
	},
	resetPassword: {
		title: 'Reset Password',
		subtitle: 'Please enter the 6-digit reset code sent to your email address.',
		passwordSubtitle: 'Please enter your new password for {{email}}.',
		form: {
			resetCode: 'Reset Code',
			newPassword: 'New Password',
			confirmPassword: 'Confirm Password',
			submit: 'Reset Password',
			verifyCode: 'Verify Code',
			verifying: 'Verifying...',
			resetting: 'Resetting...',
			errors: {
				invalidCode: 'Invalid or expired reset code',
				blankPassword: 'Password is required',
				passwordMismatch: 'Passwords do not match',
			},
		},
		back: 'Back to Login',
	},
	verification: {
		title: 'Email Verification',
		subtitle: 'Please enter the verification code sent to your email address.',
		form: {
			verificationCode: 'Verification Code',
			submit: 'Verify Email',
		},
		resendCode: 'Resend Code',
		resending: 'Resending...',
		logout: 'Logout',
	},
};
