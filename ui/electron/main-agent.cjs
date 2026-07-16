/**
 * Butler Agent-only entry point.
 * Launches directly into the standalone Agent window without the main Butler UI.
 * Used by the "Butler Agent" exe build target.
 */
process.argv.push('--agent-only');
require('./main.cjs');