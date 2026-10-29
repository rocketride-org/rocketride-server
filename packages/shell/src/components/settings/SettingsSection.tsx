// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SettingsSection — one group on a settings page: a title and description
 * on the left, the controls on the right, optional footer actions (Save,
 * Reset) underneath. Stack sections inside a PageLayout with
 * `contentWidth="narrow"` to build a settings page.
 *
 * The two columns collapse into one when the SECTION is narrow (a CSS
 * container query on the section itself), so it works the same in a full
 * page, a side panel or a webview. The section is a labelled region, so
 * screen-reader users can jump between groups.
 *
 * `danger` outlines the section in the error color for destructive settings
 * (delete project, revoke all keys). The title stays in the primary text
 * color: status reds fall below text contrast on several themes.
 *
 * Built on `.rr-settings-section` from components.css.
 */

import React, { ReactNode, useId } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link SettingsSection} component. */
export interface ISettingsSectionProps {
	/** Section title. */
	title: ReactNode;
	/** What the settings in this section do. */
	description?: ReactNode;
	/** The controls (Fields, Switches, ...). */
	children: ReactNode;
	/** Actions under the controls, right-aligned (Save, Reset). */
	footer?: ReactNode;
	/** Destructive settings: error-colored outline. */
	danger?: boolean;
	/** Heading level of the title. Defaults to 2. */
	headingLevel?: 2 | 3 | 4;
	/** Element id (for deep links to a section). */
	id?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders one settings group.
 *
 * @param props - {@link ISettingsSectionProps}.
 * @returns The section element.
 */
export function SettingsSection({ title, description, children, footer, danger = false, headingLevel = 2, id }: ISettingsSectionProps): React.ReactElement {
	const titleId = useId();
	const Heading = `h${headingLevel}` as 'h2';

	let classes = 'rr-settings-section';
	if (danger) classes += ' rr-settings-section--danger';

	return (
		<section id={id} className={classes} aria-labelledby={titleId}>
			<div className="rr-settings-section__grid">
				<div className="rr-settings-section__intro">
					<Heading id={titleId} className="rr-settings-section__title">
						{title}
					</Heading>
					{description && <p className="rr-settings-section__description">{description}</p>}
				</div>
				<div className="rr-settings-section__controls">{children}</div>
			</div>
			{footer && <div className="rr-settings-section__footer">{footer}</div>}
		</section>
	);
}
