// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React from 'react';
import ReactDOM from 'react-dom';

/**
 * Ensures React and ReactDOM are available on the window object before
 * shared-ui components are imported. Some libraries (e.g. ReactFlow)
 * expect these globals to exist at module evaluation time.
 */
(window as unknown as Record<string, unknown>).React = React;
(window as unknown as Record<string, unknown>).ReactDOM = ReactDOM;
