import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CenteredLoader } from '@/components/layout/AppShellSkeleton';
import { GuestGuard } from '@/components/layout/GuestGuard';
import { AuthCard } from '@/features/auth/AuthCard';
import { AuthSwitchLink } from '@/features/auth/AuthSwitchLink';
import { LoginForm } from '@/features/auth/LoginForm';
import { ROUTES } from '@/lib/routes';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <GuestGuard>
      <Suspense fallback={<CenteredLoader />}>
        <AuthCard
          title="Welcome back"
          description="Sign in to book and manage your appointments."
          footer={<AuthSwitchLink to={ROUTES.signup} prompt="New to Slotly?" label="Create an account" />}
        >
          <LoginForm />
        </AuthCard>
      </Suspense>
    </GuestGuard>
  );
}
