// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { Monitor } from './Monitor';
import { mountComponent } from '../../../shared/util/mount';

// Mount the Monitor view directly — it renders its own PageViewControl strip.
mountComponent(Monitor, 'Monitor');
export default Monitor;
