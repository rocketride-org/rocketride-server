// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// Make sure react is setup prior to loading shared-ui components
import '../setup.react';

import { Deployment } from './Deployment';
import { mountComponent } from '../../../shared/util/mount';

// Mount the Deployment view directly — it renders its own page strip.
mountComponent(Deployment, 'PageDeployment');
export default Deployment;
