// Every other .ts file in this folder is a driver: it default-exports a
// MouseDriver and is picked up here automatically. Adding a mouse family
// means adding one file; nothing else needs editing.
import { DriverRegistry } from '../core/registry';
import type { MouseDriver } from '../core/types';

const modules = import.meta.glob<{ default: MouseDriver }>(['./*.ts', '!./index.ts', '!./*.test.ts'], { eager: true });

export const drivers: MouseDriver[] = Object.keys(modules)
  .sort()
  .map((path) => modules[path]!.default);

export const registry = new DriverRegistry(drivers);
