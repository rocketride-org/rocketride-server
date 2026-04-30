// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// Make sure react is setup prior to loading shared-ui components
import './setup.react';

import { PageProject } from './PageProject';
import { mountComponent } from '../../../shared/util/mount';

mountComponent(PageProject, 'PageProject');
export default PageProject;
