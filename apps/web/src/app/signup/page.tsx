import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CenteredLoader } from '@/components/layout/AppShellSkeleton';
import { GuestGuard } from '@/components/layout/GuestGuard';
import { AuthCard } from '@/features/auth/AuthCard';
import { AuthSwitchLink } from '@/features/auth/AuthSwitchLink';
import { SignupForm } from '@/features/auth/SignupForm';
import { ROUTES } from '@/lib/routes';

export const metadata: Metadata = { title: 'Create your account' };

export default function SignupPage() {
  return (
    <GuestGuard>
      <Suspense fallback={<CenteredLoader />}>
        <AuthCard
          title="Create your account"
          description="Start booking in a minute, or set up a business of your own."
          footer={<AuthSwitchLink to={ROUTES.login} prompt="Already have an account?" label="Sign in" />}
        >
          <SignupForm />
        </AuthCard>
      </Suspense>
    </GuestGuard>
  );
}
