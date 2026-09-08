// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import AppWebview from './AppWebview';
import { mountComponent } from '../../../shared/util/mount';

// Override VS Code's default 20px body padding — the App Builder fills the panel
document.body.style.padding = '0';

// Create portal container for popup menus (must exist before React renders)
const portal = document.createElement('div');
portal.id = 'rr-popup-portal';
document.body.appendChild(portal);

mountComponent(AppWebview, 'AppWebview');

export default AppWebview;
