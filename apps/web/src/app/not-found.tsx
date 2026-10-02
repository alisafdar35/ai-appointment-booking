import Link from 'next/link';
import { buttonStyles } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ROUTES } from '@/lib/routes';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-lg items-center px-4">
      <EmptyState
        className="w-full"
        title="We can't find that page"
        description="The link may be old or mistyped. Your appointments and conversations are right where you left them."
        action={
          <Link href={ROUTES.assistant} className={buttonStyles()}>
            Back to the assistant
          </Link>
        }
      />
    </main>
  );
}
