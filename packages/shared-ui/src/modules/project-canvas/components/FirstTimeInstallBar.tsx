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

import { ReactElement, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, keyframes, Typography } from '@mui/material';
import { CheckCircleOutline, DeveloperBoard, WarningOutlined } from '@mui/icons-material';
import { Node } from '@xyflow/react';

import NotifyBar from './NotifyBar';
import { theme } from '../../../theme';
import { useFlow } from '../FlowContext';
import { DownloadStatusInfo, INSTALL_STATUS } from '../../../types/task-saas';
import { TaskStatus } from '../types';

/**
 * Keyframes for an animated ellipsis ("...") effect used to indicate
 * ongoing activity during connector dependency installation.
 */
const ellipsisKeyframes = keyframes`
  0% { width: 0ch; content: ""; }
  20% { width: 1ch; content: "."; }
  40% { width: 2ch; content: ".."; }
  60% { width: 3ch; content: "..."; }
  80% { width: 3ch; content: "..." }   /* hold at full dots */
  100% { width: 0ch; content: ""  }  /* reset to blank */
`;

/**
 * MUI sx styles for the animated ellipsis indicator.
 */
const styles = {
	ellipsis: {
		display: 'inline-block',
		overflow: 'hidden',
		verticalAlign: 'bottom',
		width: '3ch', // Reserve full space
		'&::after': {
			display: 'inline-block',
			animation: `${ellipsisKeyframes} 1s steps(8, end) infinite`,
			content: '""',
			whiteSpace: 'pre', // ensures spacing works as expected
		},
	},
};

/**
 * Displays a notification bar during first-time connector dependency installation.
 * Monitors task statuses from the FlowContext and shows the current download/install
 * progress for each connector. Renders different states: downloading (with animated
 * ellipsis), completed (with a fade-out success message), or error (with a warning).
 * Returns null when there is no active installation status to display.
 *
 * @returns A NotifyBar with installation status, or null if no install is in progress.
 */
export default function FirstTimeInstallBar(): ReactElement | null {
	const { t } = useTranslation();
	const flow = useFlow() as {
		taskStatuses?: Record<string, TaskStatus>;
		inventoryConnectorTitleMap?: Record<string, string>;
		nodes: Node[];
	};
	const { taskStatuses, inventoryConnectorTitleMap, nodes } = flow;

	// Cache the connector currently being downloaded so we can track its progress across re-renders
	const cachedDownloadingConnector = useRef<DownloadStatusInfo | undefined>();
	// Track whether the current task's dependency install has completed (prevents redundant UI transitions)
	const completed = useRef(false);
	// Track the current task ID to detect when we switch to a different task
	const taskId = useRef<string | undefined>();

	// Derive the current install status by inspecting taskStatuses from the engine
	const firstTimeInstallStatus = useMemo(() => {
		// No task statuses available yet; nothing to display
		if (!taskStatuses) {
			return;
		}

		// Build a set of node IDs belonging to the current project for efficient lookup
		const nodeIds = new Set(nodes.map((node: Node) => node.id));

		// Only consider task statuses for nodes that exist in the current pipeline
		const projectTaskStatuses = Object.entries(taskStatuses).filter(([nodeId]) =>
			nodeIds.has(nodeId)
		) as [string, TaskStatus][];

		if (!projectTaskStatuses || projectTaskStatuses.length === 0) {
			return;
		}

		// Find the first task that has not yet completed
		const incompleteTasks = projectTaskStatuses.find(

			([_, taskStatus]) => taskStatus.completed === false
		);
		if (!incompleteTasks) {
			// All tasks are done; reset cached state for next install cycle
			cachedDownloadingConnector.current = undefined;
			completed.current = false;

			return;
		}

		// Track which task we are monitoring so we can detect task changes
		taskId.current = incompleteTasks[0];

		const currentTask = incompleteTasks[1] as TaskStatus & {
			dependenciesInstalled?: boolean;
			firstRunDownloadStatus?: DownloadStatusInfo[];
		};

		// If the task does not report dependency install info, it is not a first-time install task
		if (!('dependenciesInstalled' in currentTask)) {
			return;
		}

		// When all dependencies are installed, show completion using the last cached connector name
		if (currentTask.dependenciesInstalled) {
			const cachedConnectorName = cachedDownloadingConnector.current?.name;

			return {
				connectorName: cachedConnectorName
					? inventoryConnectorTitleMap?.[cachedConnectorName]
					: undefined,
				status: INSTALL_STATUS.COMPLETED,
			};
		}

		const downloadStatusList = currentTask.firstRunDownloadStatus ?? [];

		// If we previously marked completion and every download entry confirms it,
		// report the last connector as completed (handles the "all done" edge case)
		if (
			taskId.current === incompleteTasks[0] &&
			completed.current === true &&
			downloadStatusList &&
			downloadStatusList.every((info) => info.status === INSTALL_STATUS.COMPLETED)
		) {
			const lastIndex = downloadStatusList.length - 1;
			const lastStatus = downloadStatusList[lastIndex];
			cachedDownloadingConnector.current = undefined;
			completed.current = true;
			return {
				connectorName: inventoryConnectorTitleMap?.[lastStatus.name],
				status: lastStatus.status,
			};
		}

		// When all downloads are present and dependencies are installed,
		// mark the final connector as completed and cache its info
		if (
			downloadStatusList &&
			downloadStatusList.length > 0 &&
			currentTask.dependenciesInstalled
		) {
			const lastIndex = downloadStatusList.length - 1;
			const lastStatus = downloadStatusList[lastIndex];
			cachedDownloadingConnector.current = lastStatus;
			completed.current = true;
			return {
				connectorName: inventoryConnectorTitleMap?.[lastStatus.name],
				status: lastStatus.status,
			};
		}

		let currentDownloadStatus: DownloadStatusInfo | undefined;

		// Search for the first connector that is actively downloading or waiting to start
		const newDownload = downloadStatusList.find(
			(info) =>
				info.status === INSTALL_STATUS.DOWNLOADING || info.status === INSTALL_STATUS.IDLE
		);

		// If we are already tracking a download, find its updated entry by name
		if (cachedDownloadingConnector.current != null) {
			currentDownloadStatus = downloadStatusList.find(
				(info) => info.name === cachedDownloadingConnector.current?.name
			);
		} else if (newDownload) {
			// Otherwise start tracking the new download in progress
			currentDownloadStatus = newDownload;
			cachedDownloadingConnector.current = currentDownloadStatus;
		}

		const connectorName = currentDownloadStatus?.name;
		const status = currentDownloadStatus?.status;

		// Once this connector's download completes, clear the cache so we pick up the next one
		if (status === INSTALL_STATUS.COMPLETED) {
			cachedDownloadingConnector.current = undefined;
		}

		return {
			// Resolve the human-readable title from the inventory map, falling back to the raw name
			connectorName: inventoryConnectorTitleMap?.[connectorName ?? ''] ?? connectorName,
			// Flag whether this is a known connector (vs. a generic dependency)
			isConnector: inventoryConnectorTitleMap?.[connectorName ?? ''] ? true : false,
			status,
		};
	}, [taskStatuses, nodes, inventoryConnectorTitleMap]);

	// No active install status means nothing to render
	if (!firstTimeInstallStatus) {
		return null;
	}

	const { connectorName, isConnector, status } = firstTimeInstallStatus;

	// Render a success banner that fades out after a short delay
	if (status === INSTALL_STATUS.COMPLETED) {
		return (
			<NotifyBar
				key={`${connectorName}-${status}`}
				icon={<CheckCircleOutline fontSize="large" />}
				fadeOut
			>
				<Box sx={{ color: 'text.secondary' }}>
					<Typography variant="h5">
						{t('flow.firstTimeDownload.complete.title')}
					</Typography>
					<Typography>{t('flow.firstTimeDownload.complete.message')}</Typography>
				</Box>
			</NotifyBar>
		);
	}

	// Render an error banner when dependency installation fails
	if (status === INSTALL_STATUS.ERROR) {
		return (
			<NotifyBar
				key={`${connectorName}-${status}`}
				icon={<WarningOutlined fontSize="large" />}
				palette={theme.palette.error}
			>
				<Typography variant="h5">{t('flow.firstTimeDownload.error.message')}</Typography>
			</NotifyBar>
		);
	}

	// Show an in-progress banner with animated ellipsis while downloading or waiting
	if (status === INSTALL_STATUS.DOWNLOADING || status === INSTALL_STATUS.IDLE) {
		return (
			<NotifyBar
				key={`${connectorName}-${status}`}
				icon={<DeveloperBoard fontSize="large" />}
			>
				<Typography variant="h5">
					{isConnector
						? t('flow.firstTimeDownload.incomplete.title')
						: t('flow.firstTimeDownload.incomplete.installing')}
					<strong>{connectorName}</strong>
					<Box sx={styles.ellipsis}></Box>
				</Typography>
			</NotifyBar>
		);
	}

	return null;
}
