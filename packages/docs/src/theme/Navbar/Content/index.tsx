/**
 * Swizzled from @docusaurus/theme-classic Navbar/Content (v3.8.1).
 *
 * Only change from upstream: in the right navbar group, <SearchBar> renders
 * BEFORE <NavbarColorModeToggle> so the color-mode toggle sits to the RIGHT of
 * the search box. CSS `order` is avoided because the toggle's class is a hashed
 * CSS-module name. Re-check this file after any @docusaurus/* upgrade (pinned
 * exact at 3.8.1).
 */
import React from 'react';
import clsx from 'clsx';
import { useThemeConfig, ErrorCauseBoundary, ThemeClassNames } from '@docusaurus/theme-common';
import { splitNavbarItems, useNavbarMobileSidebar } from '@docusaurus/theme-common/internal';
import NavbarItem from '@theme/NavbarItem';
import NavbarColorModeToggle from '@theme/Navbar/ColorModeToggle';
import SearchBar from '@theme/SearchBar';
import NavbarMobileSidebarToggle from '@theme/Navbar/MobileSidebar/Toggle';
import NavbarLogo from '@theme/Navbar/Logo';
import NavbarSearch from '@theme/Navbar/Search';
import styles from './styles.module.css';

function useNavbarItems() {
	// TODO temporary casting until ThemeConfig type is improved
	return useThemeConfig().navbar.items as object[];
}

function NavbarItems({ items }: { items: object[] }): React.ReactNode {
	return (
		<>
			{items.map((item, i) => (
				<ErrorCauseBoundary
					key={i}
					onError={(error) =>
						new Error(
							`A theme navbar item failed to render.
Please double-check the following navbar item (themeConfig.navbar.items) of your Docusaurus config:
${JSON.stringify(item, null, 2)}`,
							{ cause: error }
						)
					}
				>
					<NavbarItem {...item} />
				</ErrorCauseBoundary>
			))}
		</>
	);
}

function NavbarContentLayout({ left, right }: { left: React.ReactNode; right: React.ReactNode }): React.ReactNode {
	return (
		<div className="navbar__inner">
			<div className={clsx(ThemeClassNames.layout.navbar.containerLeft, 'navbar__items')}>{left}</div>
			<div className={clsx(ThemeClassNames.layout.navbar.containerRight, 'navbar__items navbar__items--right')}>{right}</div>
		</div>
	);
}

export default function NavbarContent(): React.ReactNode {
	const mobileSidebar = useNavbarMobileSidebar();
	const items = useNavbarItems();
	const [leftItems, rightItems] = splitNavbarItems(items);
	const searchBarItem = items.find((item: { type?: string }) => item.type === 'search');
	return (
		<NavbarContentLayout
			left={
				<>
					{!mobileSidebar.disabled && <NavbarMobileSidebarToggle />}
					<NavbarLogo />
					<NavbarItems items={leftItems} />
				</>
			}
			right={
				// Search first, color-mode toggle last (toggle to the right of search).
				<>
					<NavbarItems items={rightItems} />
					{!searchBarItem && (
						<NavbarSearch>
							<SearchBar />
						</NavbarSearch>
					)}
					<NavbarColorModeToggle className={styles.colorModeToggle} />
				</>
			}
		/>
	);
}
