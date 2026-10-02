'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from './AuthProvider';
import { QueryProvider } from './QueryProvider';
import { RealtimeProvider } from './RealtimeProvider';
import { ToastProvider } from './ToastProvider';

/**
 * The provider stack, outermost first. Order encodes dependencies: Auth needs
 * the query client (to clear caches on sign-out), Realtime needs both Auth
 * (connect only while signed in) and the query client (to update caches).
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <ToastProvider>
        <AuthProvider>
          <RealtimeProvider>{children}</RealtimeProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryProvider>
  );
}
