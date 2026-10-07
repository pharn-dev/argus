/** Message protocol between the worker pool and its workers. Types and one guard, no I/O. */

export type TaskRequest = { id: number; payload: unknown };

export type SerializedError = { name: string; message: string; stack?: string };

export type TaskReply =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: SerializedError };

/** Structural membership check for a message a worker sent back. */
export function isTaskReply(value: unknown): value is TaskReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as { id?: unknown; ok?: unknown; error?: unknown };
  if (typeof reply.id !== 'number' || !Number.isInteger(reply.id)) return false;
  if (reply.ok === true) return true;
  if (reply.ok !== false) return false;
  if (typeof reply.error !== 'object' || reply.error === null) return false;
  const error = reply.error as { name?: unknown; message?: unknown };
  return typeof error.name === 'string' && typeof error.message === 'string';
}
