// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// TEST SESSION VIEW — Tab content for a single test session
// =============================================================================
//
// Each tab is a fully independent instance. ALL state lives here.
// When isActive becomes true, this tab pushes its saved view to the
// nav store so the sidebar highlights the correct button.
// When the sidebar changes the view, the nav store updates, this tab
// picks it up and saves it.
// =============================================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useShellConnection } from 'shell-ui';
import { createTestEngine } from './engine';
import type { TestConfig, EngineState } from './types';
import { styles } from './styles';
import { DEFAULT_CONFIG } from './session';
import type { TestConnectionContent } from './connections';
import { getDocs } from './docs';
import { setView, useViewRequest } from './navigation';
import type { ViewId } from './navigation';
import { setActionHandler, setEngineState as syncEngineState, setActiveEditor, cleanupEditor } from './actions';

import MetricsPanel from './panels/MetricsPanel';
import SwarmPanel from './panels/SwarmPanel';
import LatencyPanel from './panels/LatencyPanel';
import ApiCoveragePanel from './panels/ApiCoveragePanel';
import EventStream from './panels/EventStream';
import ScenarioList from './panels/ScenarioList';
import PhaseProgress from './panels/PhaseProgress';
import SettingsPanel from './panels/SettingsPanel';
import StatsBar from './panels/StatsBar';

const KEYFRAMES = `
@keyframes rr-test-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}
`;

const ALL_PHASE_IDS = ['sweep', 'stress', 'flood', 'pipe', 'chaos', 'hammer'];

// =============================================================================
// COMPONENT
// =============================================================================

interface TestSessionViewProps {
	connection: TestConnectionContent;
	editorId: string;
	isActive: boolean;
}

const TestSessionView: React.FC<TestSessionViewProps> = ({ connection, editorId, isActive }) => {
	useShellConnection();

	// ── Restore from viewState once at mount ──
	const docs = getDocs();
	const saved = useRef<{ config?: TestConfig; selectedPhases?: string[]; view?: ViewId } | undefined>(undefined);
	if (saved.current === undefined) {
		saved.current = docs?.getState()?.editors?.[editorId]?.viewState as typeof saved.current;
	}

	// ── Engine — per-tab instance, stays alive because component stays mounted.
	//    Lazy ref init: useRef(createTestEngine()) would build and discard a
	//    fresh engine on every render, so only construct on first render. ──
	const engineRef = useRef<ReturnType<typeof createTestEngine> | null>(null);
	const engine = engineRef.current ?? (engineRef.current = createTestEngine());

	const [currentView, setCurrentView] = useState<ViewId>(saved.current?.view || 'dashboard');
	const [config, setConfig] = useState<TestConfig>(saved.current?.config || connection.config || DEFAULT_CONFIG);
	const [engineState, setEngineState] = useState<EngineState>('idle');
	const [, setTick] = useState(0);
	const [selectedPhases, setSelectedPhases] = useState<Set<string>>(
		new Set(saved.current?.selectedPhases || connection.selectedPhases || ALL_PHASE_IDS),
	);

	// ── Persist to viewState ──
	useEffect(() => {
		docs?.updateEditorViewState(editorId, {
			config,
			selectedPhases: Array.from(selectedPhases),
			view: currentView,
		});
	}, [config, selectedPhases, currentView]);

	// ── Rule 2: When this tab becomes active, tell sidebar our current view ──
	//    setView also clears any stale viewRequest from a previous tab
	useEffect(() => {
		if (isActive) {
			setActiveEditor(editorId);
			setView(currentView); // clears _viewRequest
			syncEngineState(editorId, engineState);
		}
	}, [isActive, editorId]);

	// ── Rule 3: When sidebar requests a view change, apply it locally then confirm ──
	const viewRequest = useViewRequest();
	const ready = useRef(false);
	useEffect(() => {
		// Skip stale requests that were pending before this tab mounted
		if (!ready.current) return;
		if (!isActive || !viewRequest || viewRequest === currentView) return;
		setCurrentView(viewRequest);
		setView(viewRequest);
	}, [viewRequest]);

	// Mark ready after first render so we ignore stale requests
	useEffect(() => { ready.current = true; }, []);

	// ── Cleanup ──
	useEffect(() => () => cleanupEditor(editorId), [editorId]);

	// ── Engine subscription ──
	useEffect(() => {
		let raf: number | null = null;
		let dirty = false;
		const unsub = engine.onUpdate(() => {
			dirty = true;
			if (raf === null) {
				raf = requestAnimationFrame(() => {
					raf = null;
					if (dirty) {
						dirty = false;
						setEngineState(engine.state);
						syncEngineState(editorId, engine.state);
						setTick((t) => t + 1);
					}
				});
			}
		});
		return () => { unsub(); if (raf !== null) cancelAnimationFrame(raf); };
	}, [engine]);

	// ── Action handlers ──
	const handleStart = useCallback(() => engine.start(config, selectedPhases), [engine, config, selectedPhases]);
	const handleAbort = useCallback(() => engine.abort(), [engine]);
	const handlePause = useCallback(() => engine.pause(), [engine]);
	const handleResume = useCallback(() => engine.resume(), [engine]);
	const handleClear = useCallback(() => { engine.clear(); setTick(0); }, [engine]);
	const handleReset = useCallback(() => {
		engine.reset();
		setConfig(DEFAULT_CONFIG);
		setSelectedPhases(new Set(ALL_PHASE_IDS));
		setTick(0);
	}, [engine]);

	useEffect(() => {
		setActionHandler(editorId, (action) => {
			switch (action) {
				case 'start': handleStart(); break;
				case 'abort': handleAbort(); break;
				case 'pause': handlePause(); break;
				case 'resume': handleResume(); break;
				case 'clear': handleClear(); break;
				case 'reset': handleReset(); break;
			}
		});
		return () => setActionHandler(editorId, null);
	}, [handleStart, handleAbort, handlePause, handleResume, handleClear, handleReset]);

	// ── Render ──
	return (
		<div style={styles.root}>
			<style>{KEYFRAMES}</style>

			{currentView === 'dashboard' && (
				<div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' as const, overflow: 'auto' }}>
					<div style={styles.gridArea}>
						<MetricsPanel
							metrics={engine.metrics} apiResults={engine.apiResults}
							worstPing={engine.worstPing} worstPingSnapshot={engine.worstPingSnapshot}
							engineState={engineState}
							onStart={handleStart} onAbort={handleAbort}
							onPause={handlePause} onResume={handleResume}
							onClear={handleClear}
						/>
						<PhaseProgress phases={engine.phases} selectedPhases={selectedPhases} />
						<SwarmPanel pipelines={engine.pipelines} />
						<LatencyPanel samples={engine.latencyHistory} />
						<ApiCoveragePanel results={engine.apiResults} />
					</div>
				</div>
			)}

			{currentView === 'settings' && (
				<SettingsPanel
					config={config}
					onConfigChange={setConfig}
					engineState={engineState}
					phases={engine.phases}
					selectedPhases={selectedPhases}
					onTogglePhase={(id) => {
						setSelectedPhases((prev) => {
							const next = new Set(prev);
							if (next.has(id)) next.delete(id); else next.add(id);
							return next;
						});
					}}
					onSelectAll={() => setSelectedPhases(new Set(ALL_PHASE_IDS))}
					onDeselectAll={() => setSelectedPhases(new Set())}
					onReset={handleReset}
				/>
			)}

			{currentView === 'events' && (
				<div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' }}>
					<EventStream events={engine.events} filter="all" />
				</div>
			)}

			{currentView === 'errors' && (
				<div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' }}>
					<EventStream events={engine.events} filter="errors" />
				</div>
			)}

			{currentView === 'scenarios' && (
				<div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' }}>
					<ScenarioList engine={engine} engineState={engineState} />
				</div>
			)}

			<StatsBar metrics={engine.metrics} />
		</div>
	);
};

export default TestSessionView;
