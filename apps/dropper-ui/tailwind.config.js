/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

/**
 * Tailwind CSS Configuration for RocketRide Dropper
 *
 * This configuration extends Tailwind CSS with custom colors, fonts,
 * and utilities specific to the RocketRide brand and dropper needs.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
	content: [
		'./index.html',
		'./src/**/*.{js,ts,jsx,tsx}',
		'./public/**/*.html',
	],

	theme: {
		extend: {
			// Custom colors for RocketRide branding
			colors: {
				rocketride: {
					50: '#eff6ff',
					100: '#dbeafe',
					200: '#bfdbfe',
					300: '#93c5fd',
					400: '#60a5fa',
					500: '#3b82f6', // Primary brand color
					600: '#2563eb',
					700: '#1d4ed8',
					800: '#1e40af',
					900: '#1e3a8a',
					950: '#172554',
				},

				// Status colors
				success: {
					50: '#f0fdf4',
					100: '#dcfce7',
					200: '#bbf7d0',
					300: '#86efac',
					400: '#4ade80',
					500: '#22c55e',
					600: '#16a34a',
					700: '#15803d',
					800: '#166534',
					900: '#14532d',
				},

				warning: {
					50: '#fffbeb',
					100: '#fef3c7',
					200: '#fde68a',
					300: '#fcd34d',
					400: '#fbbf24',
					500: '#f59e0b',
					600: '#d97706',
					700: '#b45309',
					800: '#92400e',
					900: '#78350f',
				},

				danger: {
					50: '#fef2f2',
					100: '#fee2e2',
					200: '#fecaca',
					300: '#fca5a5',
					400: '#f87171',
					500: '#ef4444',
					600: '#dc2626',
					700: '#b91c1c',
					800: '#991b1b',
					900: '#7f1d1d',
				},
			},

			// Custom fonts
			fontFamily: {
				sans: [
					'Inter',
					'-apple-system',
					'BlinkMacSystemFont',
					'"Segoe UI"',
					'Roboto',
					'"Helvetica Neue"',
					'Arial',
					'sans-serif',
				],
				mono: [
					'"SF Mono"',
					'Monaco',
					'Inconsolata',
					'"Roboto Mono"',
					'Consolas',
					'"Liberation Mono"',
					'"Courier New"',
					'monospace',
				],
			},

			// Custom spacing
			spacing: {
				'18': '4.5rem',
				'88': '22rem',
				'128': '32rem',
			},

			// Custom border radius
			borderRadius: {
				'xl': '1rem',
				'2xl': '1.5rem',
				'3xl': '2rem',
			},

			// Custom shadows with brand colors
			boxShadow: {
				'rocketride': '0 4px 6px -1px rgba(59, 130, 246, 0.1), 0 2px 4px -1px rgba(59, 130, 246, 0.06)',
				'rocketride-lg': '0 10px 15px -3px rgba(59, 130, 246, 0.1), 0 4px 6px -2px rgba(59, 130, 246, 0.05)',
			},

			// Custom animations
			animation: {
				'fade-in': 'fadeIn 0.3s ease-out',
				'slide-in': 'slideIn 0.3s ease-out',
				'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
				'bounce-slow': 'bounce 2s infinite',
				'spin-slow': 'spin 3s linear infinite',
			},

			// Custom keyframes
			keyframes: {
				fadeIn: {
					'0%': { opacity: '0', transform: 'translateY(10px)' },
					'100%': { opacity: '1', transform: 'translateY(0)' },
				},
				slideIn: {
					'0%': { opacity: '0', transform: 'translateX(-20px)' },
					'100%': { opacity: '1', transform: 'translateX(0)' },
				},
			},

			// Custom transitions
			transitionDuration: {
				'400': '400ms',
				'600': '600ms',
			},

			// Custom aspect ratios for charts
			aspectRatio: {
				'chart': '16 / 9',
				'square-chart': '1 / 1',
				'wide-chart': '21 / 9',
			},

			// Custom max widths
			maxWidth: {
				'8xl': '88rem',
				'9xl': '96rem',
			},

			// Custom z-index scale
			zIndex: {
				'60': '60',
				'70': '70',
				'80': '80',
				'90': '90',
				'100': '100',
			},

			// Custom backdrop blur
			backdropBlur: {
				xs: '2px',
			},

			// Custom grid template columns for dashboard layouts
			gridTemplateColumns: {
				'dashboard': 'repeat(auto-fit, minmax(300px, 1fr))',
				'metrics': 'repeat(auto-fit, minmax(250px, 1fr))',
				'sidebar': '250px 1fr',
				'sidebar-collapsed': '60px 1fr',
			},

			// Custom grid template rows
			gridTemplateRows: {
				'layout': 'auto 1fr auto',
			},
		},
	},

	// Plugins for additional functionality
	plugins: [
		// Add form styling plugin
		require('@tailwindcss/forms')({
			strategy: 'class', // Use class-based form styling
		}),

		// Add typography plugin for rich text content
		require('@tailwindcss/typography'),

		// Add aspect ratio plugin (if using older Tailwind version)
		require('@tailwindcss/aspect-ratio'),

		// Custom plugin for dashboard-specific utilities
		function ({ addUtilities, addComponents, theme }) {
			// Add custom utilities
			addUtilities({
				'.text-balance': {
					'text-wrap': 'balance',
				},
				'.scrollbar-hide': {
					'-ms-overflow-style': 'none',
					'scrollbar-width': 'none',
					'&::-webkit-scrollbar': {
						display: 'none',
					},
				},
				'.bg-dot-pattern': {
					'background-image': 'radial-gradient(circle, #e5e7eb 1px, transparent 1px)',
					'background-size': '20px 20px',
				},
			});

			// Add custom components
			addComponents({
				'.dashboard-card': {
					'@apply bg-white rounded-lg shadow-sm border border-gray-200 p-6 transition-shadow duration-200 hover:shadow-md': {},
				},
				'.metric-card': {
					'@apply dashboard-card flex flex-col space-y-2': {},
				},
				'.status-indicator': {
					'@apply inline-flex items-center px-2 py-1 rounded-full text-xs font-medium': {},
				},
				'.loading-skeleton': {
					'@apply animate-pulse bg-gray-200 rounded': {},
				},
			});
		},
	],

	// Dark mode configuration
	darkMode: 'class', // Use class-based dark mode

	// Safelist for dynamic classes (classes that might be generated dynamically)
	safelist: [
		// Status colors that might be applied dynamically
		'bg-green-100', 'text-green-800', 'border-green-200',
		'bg-red-100', 'text-red-800', 'border-red-200',
		'bg-yellow-100', 'text-yellow-800', 'border-yellow-200',
		'bg-blue-100', 'text-blue-800', 'border-blue-200',
		'bg-gray-100', 'text-gray-800', 'border-gray-200',

		// Progress bar widths
		...Array.from({ length: 101 }, (_, i) => `w-[${i}%]`),

		// Grid column spans for responsive layouts
		'col-span-1', 'col-span-2', 'col-span-3', 'col-span-4',
		'col-span-6', 'col-span-12',
	],
};
