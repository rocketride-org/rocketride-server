import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// The IA spine is the single source of truth (shared with docs:gather).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toSidebar } = require('./scripts/lib/spine');

const sidebars: SidebarsConfig = toSidebar();

export default sidebars;
