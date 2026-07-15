// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// Make sure react is setup prior to loading shared-ui components
import './setup.react';

import { Project } from './Project';
import { mountComponent } from '../../../shared/util/mount';

// Mount the Project view directly — it renders its own PageViewControl strip.
mountComponent(Project, 'PageProject');
export default Project;
