import type { CollectorPlaceholder } from '../collector/index.js';

/** Scaffold placeholder — kept so the scaffold test stays valid. */
export type DashboardPlaceholder = CollectorPlaceholder;

/** True for localhost, ::1 and 127.0.0.0/8. A dashboard bound anywhere else needs a token. */
export { isLoopbackHost } from './auth.js';

export {
  createDashboardServer,
  type DashboardServer,
  type DashboardServerOptions,
} from './server.js';
