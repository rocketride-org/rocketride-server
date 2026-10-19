// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// Make sure react is setup prior to loading shared components
import '../setup.react';

import { Pipeline } from './Pipeline';
import { mountComponent } from '../../../shared/util/mount';
import { attachBusRealm } from '../hooks/busRealm';

// The editor realm's one bus attachment — boot state, per-doc topics, and
// engine access all ride the bus.
attachBusRealm();

// Mount the pipeline view directly — it renders its own TabControl strip.
mountComponent(Pipeline, 'Pipeline');
export default Pipeline;
