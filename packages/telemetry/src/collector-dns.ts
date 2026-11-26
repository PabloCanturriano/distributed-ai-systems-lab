import { Resolver } from 'node:dns';
import { isIPv4, type LookupFunction } from 'node:net';

interface CollectorResolver {
  resolve4(
    host: string,
    callback: (
      error: NodeJS.ErrnoException | null,
      addresses: string[],
    ) => void,
  ): void;
  cancel(): void;
}

// Docker's local backend is IPv4. Keep collector DNS off the shared getaddrinfo
// worker pool used by PostgreSQL and other business dependencies.
export function createCollectorLookup(
  createResolver: () => CollectorResolver = () =>
    new Resolver({ timeout: 250, tries: 1 }),
): LookupFunction {
  let pending = 0;
  const unavailable = () =>
    Object.assign(new Error('Collector DNS unavailable'), {
      code: 'EAI_AGAIN',
    });
  return (hostname, options, callback) => {
    if (hostname !== 'collector' || options.family === 6 || pending >= 2) {
      queueMicrotask(() => callback(unavailable(), '', 4));
      return;
    }
    pending++;
    let finished = false;
    let resolver: CollectorResolver | undefined;
    const timer = setTimeout(() => finish(unavailable(), []), 350);
    timer.unref();
    function finish(
      error: NodeJS.ErrnoException | null,
      values: string[],
    ): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending--;
      try {
        resolver?.cancel();
      } catch {}
      const addresses = Array.isArray(values)
        ? values
            .filter((value) => typeof value === 'string' && isIPv4(value))
            .slice(0, 8)
        : [];
      if (error || !addresses.length) callback(unavailable(), '', 4);
      else if (options.all)
        callback(
          null,
          addresses.map((address) => ({ address, family: 4 })),
        );
      else callback(null, addresses[0]!, 4);
    }
    try {
      resolver = createResolver();
      resolver.resolve4(hostname, finish);
    } catch {
      finish(unavailable(), []);
    }
  };
}
