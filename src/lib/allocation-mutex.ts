import { Mutex } from 'async-mutex';

const allocationMutexes = new Map<string, Mutex>();

export function getOrCreateMutex(allocationId: string): Mutex {
  let mutex = allocationMutexes.get(allocationId);
  if (!mutex) {
    // Safety cap: prevent unbounded growth from stale allocation IDs
    if (allocationMutexes.size > 100) {
      allocationMutexes.clear();
    }
    mutex = new Mutex();
    allocationMutexes.set(allocationId, mutex);
  }
  return mutex;
}
