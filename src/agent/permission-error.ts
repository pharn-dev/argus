/**
 * Thrown when the Node permission model (`--permission`) denies a file system
 * access the agent needs. Names the denied scope, the absolute resource and the
 * flag that would grant it.
 */
export class ArgusPermissionError extends Error {
  readonly scope: string;
  readonly resource: string;
  readonly code = 'ARGUS_ERR_PERMISSION_DENIED';

  constructor(scope: string, resource: string, options?: ErrorOptions) {
    const flag = scope === 'fs.read' ? '--allow-fs-read' : '--allow-fs-write';
    super(
      `argus: permission denied for ${scope} on ${resource}; grant it with ${flag}=<${resource} or its directory>`,
      options,
    );
    this.name = 'ArgusPermissionError';
    this.scope = scope;
    this.resource = resource;
  }
}
