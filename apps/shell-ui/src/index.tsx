// Async boundary — required by Module Federation so the MF runtime can
// initialize shared module versions (react, shell-ui, etc.) before any
// synchronous imports run. Without this, loadShareSync throws RUNTIME-006.
import('./bootstrap');
