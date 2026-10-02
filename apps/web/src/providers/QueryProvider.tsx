'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { queryRetryDelay, shouldRetryQuery } from '@/lib/queries';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Fresh for 30s: navigating between pages does not refetch, but coming
        // back to the tab does (refetchOnWindowFocus), which is how a stale
        // dashboard corrects itself when the realtime socket is unavailable.
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
      },
      // A mutation is a user's intent, not a read: silently repeating a booking
      // could double-submit it. Failures are shown and the user decides.
      mutations: { retry: false },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // useState, not a module constant: a module-level client would be shared
  // between users during server rendering.
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
