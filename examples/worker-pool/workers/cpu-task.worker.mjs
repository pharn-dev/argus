import { parentPort, workerData } from 'node:worker_threads';

// CPU-heavy task: count the primes below `limit` by integer trial division.
// Runs on its own Worker Thread so the main event loop stays free.
function countPrimes(limit) {
  let primes = 0;
  for (let n = 2; n < limit; n += 1) {
    let isPrime = true;
    for (let d = 2; d * d <= n; d += 1) {
      if (n % d === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) primes += 1;
  }
  return primes;
}

const limit = workerData?.limit;
if (!Number.isSafeInteger(limit) || limit <= 0) {
  throw new TypeError('cpu-task worker needs workerData.limit to be a positive safe integer');
}
if (parentPort === null) {
  throw new Error('cpu-task worker must be started as a worker thread');
}

parentPort.postMessage({ primes: countPrimes(limit) });
