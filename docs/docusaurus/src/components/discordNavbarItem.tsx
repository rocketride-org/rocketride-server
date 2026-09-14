import React from 'react';
import clsx from 'clsx';
import { SiDiscord } from 'react-icons/si';

type Props = {
	href: string;
	label?: string;
	className?: string;
	mobile?: boolean;
};

/**
 * Navbar Discord link: an icon-only link to the community server, styled to sit
 * next to the GitHub item. No live data, unlike the GitHub stars item, just a
 * link, so it renders the same on server and client.
 *
 * @param props - Navbar item config: the Discord invite `href`, optional `label`
 *   (accessible name), and the `mobile` flag Docusaurus passes in the mobile menu.
 * @return The rendered navbar link.
 */
export default function DiscordNavbarItem({ href, label = 'Discord', className, mobile }: Props): React.ReactNode {
	return (
		<a className={clsx('navbar__item', 'navbar__link', 'navbar-discord', mobile && 'menu__link', className)} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
			<SiDiscord className="navbar-discord__icon" aria-hidden="true" />
		</a>
	);
}
