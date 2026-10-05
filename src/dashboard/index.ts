import type { CollectorPlaceholder } from '../collector/index.js';

/** Scaffold placeholder — kept so the scaffold test stays valid. */
export type DashboardPlaceholder = CollectorPlaceholder;

export {
  createDashboardServer,
  type DashboardServer,
  type DashboardServerOptions,
} from './server.js';
