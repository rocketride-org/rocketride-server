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

// The deployed-version card pieces both DEPLOY screens share.
export { DeleteVersionMark } from './DeleteVersionMark';
export { deleteConfirmPropsOf } from './DeleteVersionMark';
export type { IDeleteConfirmInput, IDeleteVersionMarkProps } from './DeleteVersionMark';
export { VersionStateBadge } from './VersionStateBadge';
export type { IVersionStateBadge, IVersionStateBadgeProps } from './VersionStateBadge';
export { VersionCardActions } from './VersionCardActions';
export type { IVersionCardActionsProps } from './VersionCardActions';
export { newestSubmittableOf, versionCardActionsOf, storeOpenFor, storeTargetOf, STORE_TARGET_ID } from './reviewRules';
export type { IReviewVersion, IVersionCardAbilities, IVersionCardActions, IStoreTargetInput } from './reviewRules';

// The "Publish vN to…" dialog both screens open from a card.
export { PublishToDialog } from './PublishToDialog';
export type { IPublishTarget, IPublishToDialogProps } from './PublishToDialog';

// The where-live row's state word both screens draw.
export { ServingStateWord } from './ServingStateWord';
export type { IServingStatus, IServingStateWordProps } from './ServingStateWord';
