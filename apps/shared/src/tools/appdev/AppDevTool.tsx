// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

// =============================================================================
// APPDEV TOOL — the builtin App Builder tool's CONTROLLER
// =============================================================================
//
// Owns the MY APPS list, fed by the host's `appdevApps` stream (the one
// host-variant source — what a working copy IS differs per host: rocket-ui
// scans the server store's .appdev tree, VS Code watches the local
// workspace for .rrapp bindings). All actions are generic pages:
// 'app:<id>' opens a builder screen, 'newapp' the wizard.
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { DevToolProps } from 'shell';
import { useToolHost } from '../core/ToolContext';
import { AppDevSidebarPanel } from './AppDevSidebarPanel';
import { startWorkspaceAppDiscovery } from './controller';
import type { AppBuilderSidebar } from './sidebarTypes';
import type { AppListItem } from './sidebarTypes';
import type { IntroMode } from '../introCatalog';

/** The appdev tool's sidebar controller. */
export const AppDevTool: React.FC<DevToolProps> = ({ documents }) => {
	const services = useToolHost();
	// Hosts serving the appdevFrames seam get TOOL documents
	// (tool:apps/newapp, tool:apps/<id>); others keep their legacy pages.
	const toolDocs = !!services.appdevFrames;

	const [apps, setApps] = useState<AppListItem[]>([]);
	useEffect(() => {
		// The host's working-copy stream when it provides one; otherwise the
		// tool discovers over workspaceFs itself — the same host-variant
		// fallback pair the pipelines tool uses (rocket-ui feeds the stream;
		// VS Code serves workspaceFs and gets the .rrapp scan).
		if (services.appdevApps) return services.appdevApps.subscribe(setApps);
		if (services.workspaceFs) return startWorkspaceAppDiscovery(services.workspaceFs, setApps);
		return undefined;
	}, [services.appdevApps, services.workspaceFs]);

	const activePrefix = toolDocs ? 'tool:apps/' : 'app:';
	const appBuilder: AppBuilderSidebar = {
		apps,
		...(services.activeDocKey?.startsWith(activePrefix) ? { activeAppId: services.activeDocKey.slice(activePrefix.length) } : {}),
		onNewApp: () => (toolDocs ? documents?.open('newapp', 'New App') : services.openPage('newapp', 'New App')),
		onOpenApp: (appId: string) => {
			const name = apps.find((a) => a.id === appId)?.name ?? appId;
			if (toolDocs) documents?.open(appId, name);
			else services.openPage(`app:${appId}`, name);
		},
	};

	// No Desktop affordance: the modules picker (tool store) replaced it.
	// DesktopView survives as an ordinary shell component for apps.
	return (
		<AppDevSidebarPanel
			appBuilder={appBuilder}
			onShowIntro={(mode: IntroMode) => services.openPage(`intro:${mode}`)}
		/>
	);
};
