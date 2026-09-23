// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { Account } from './Account';
import { mountComponent } from '../../../shared/util/mount';

// Mount the Account view directly — it renders its own TabControl strip.
mountComponent(Account, 'Account');
export default Account;
