// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { SidebarMain } from './SidebarMain';
import { mountComponent } from '../../../shared/util/mount';

// Override VS Code's default 20px body padding for this sidebar view
document.body.style.padding = '0';

mountComponent(SidebarMain, 'SidebarMain');

export default SidebarMain;
