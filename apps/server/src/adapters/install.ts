import { ApiLoopAdapter, ClaudeCodeAdapter } from '@agentforge/core';
import type { AdapterRegistry } from '../contexts/agent-registry/application/adapter-registry';

/**
 * Installs the shipped adapters. Called in BOTH entrypoints: the worker
 * executes them; the api only needs ids + capabilities for /adapters and
 * canvas validation.
 */
export function installAdapters(registry: AdapterRegistry): void {
  registry.register(new ApiLoopAdapter());
  registry.register(new ClaudeCodeAdapter());
}
