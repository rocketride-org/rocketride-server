/**
 * Contrast ratio regression test.
 *
 * Ensures the --text-muted CSS variable maintains WCAG AA compliance (4.5:1).
 * Bug C1: Mariner visual agent found input placeholder failed WCAG AA.
 * Fix: changed --text-muted from #7a7a7a to #a8a8a8.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function hexToLuminance(hex: string): number {
	hex = hex.replace('#', '');
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);

	const toLinear = (v: number): number => {
		const s = v / 255;
		return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};

	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fg: string, bg: string): number {
	let l1 = hexToLuminance(fg);
	let l2 = hexToLuminance(bg);
	if (l1 < l2) [l1, l2] = [l2, l1];
	return (l1 + 0.05) / (l2 + 0.05);
}

describe('WCAG Contrast Compliance', () => {
	it('--text-muted passes WCAG AA (4.5:1) on dark background', () => {
		const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf-8');
		const match = css.match(/--text-muted:\s*(#[0-9a-fA-F]{6})/);
		expect(match).not.toBeNull();

		const textMuted = match![1];
		const darkBg = '#383B44'; // dark theme input background

		const ratio = contrastRatio(textMuted, darkBg);
		expect(ratio).toBeGreaterThanOrEqual(4.5);
	});
});
