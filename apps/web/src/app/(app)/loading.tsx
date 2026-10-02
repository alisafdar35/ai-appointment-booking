import { Skeleton } from '@/components/ui/Skeleton';

/** Route-transition fallback; renders inside the shell, so the header stays put. */
export default function AppLoading() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="mt-6 h-64 w-full rounded-xl" />
    </div>
  );
}
