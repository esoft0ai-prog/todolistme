import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServiceContext } from '../services/context';
import { useAppStore } from './appStore';

export interface QueryState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Loads data from the local database and re-runs whenever data changes
 * (dataVersion) or `deps` change. Stale responses are discarded.
 */
export function useQuery<T>(loader: (ctx: ServiceContext) => Promise<T>, deps: unknown[] = []): QueryState<T> {
  const ctx = useAppStore((s) => s.ctx);
  const version = useAppStore((s) => s.dataVersion);
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: string | null }>({ data: undefined, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!ctx) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    loaderRef
      .current(ctx)
      .then((data) => {
        if (id === seq.current) setState({ data, loading: false, error: null });
      })
      .catch((e) => {
        if (id === seq.current) setState((s) => ({ data: s.data, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, version, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
