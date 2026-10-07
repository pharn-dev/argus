// Resource accounting for the soak children: heap after a forced GC, live Worker threads, and
// child-process handles. The children run with --expose-gc.
import { sleep } from './common.mjs';

const GC_READINGS = 3;

/**
 * heapUsed after a full GC. Takes the minimum of a few readings, because whatever is in flight
 * at the moment of a reading is noise, while retained memory is in every reading.
 */
export async function heapAfterGc() {
  const gc = globalThis.gc;
  if (typeof gc !== 'function') throw new Error('heapAfterGc needs node --expose-gc');
  const readings = [];
  for (let i = 0; i < GC_READINGS; i += 1) {
    gc();
    readings.push(process.memoryUsage().heapUsed);
    await sleep(50);
  }
  return Math.min(...readings);
}

let liveWorkers = 0;
let createdWorkers = 0;

/** Count Worker threads from creation to exit. Call once, before any worker is created. */
export function trackWorkers() {
  process.on('worker', (worker) => {
    liveWorkers += 1;
    createdWorkers += 1;
    worker.once('exit', () => {
      liveWorkers -= 1;
    });
  });
}

export function resourceSnapshot() {
  const active = process.getActiveResourcesInfo();
  return {
    liveWorkers,
    createdWorkers,
    childProcesses: active.filter((name) => name === 'ProcessWrap').length,
    activeResources: active,
  };
}
