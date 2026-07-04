// =============================================================================
// BINARY VIEWER — fallback for unsupported file types
// =============================================================================

import React from 'react';
import { viewerStyles } from './styles';

export const BinaryViewer: React.FC = () => (
	<div style={viewerStyles.message}>This file type cannot be previewed.</div>
);
