'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, loginSchema } from '@appt/shared';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { hasErrorCode } from '@/lib/api';
import { applyApiFieldErrors } from '@/lib/form-errors';
import { SESSION_EXPIRED_PARAM } from '@/lib/routes';
import { useAuth } from '@/providers/AuthProvider';
import { describeAuthError, firstServerErrorField, type AuthFormError } from './auth-errors';
import { DEMO_ACCOUNT } from './demo-account';
import { authParseOptions } from './error-map';
import { PasswordField } from './PasswordField';

type LoginFormInput = z.input<typeof loginSchema>;
type LoginFormValues = z.output<typeof loginSchema>;

/**
 * Email + password sign-in.
 *
 * On success this form does nothing further: AuthProvider flips to
 * "authenticated" and GuestGuard (which wraps the page) performs the redirect
 * to the validated `?next=` target. Navigating here as well would race it.
 */
export function LoginForm() {
  const { login } = useAuth();
  const [formError, setFormError] = useState<AuthFormError | null>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  // From the router, not window.location: after a client-side redirect here the
  // form can mount before the browser's URL has been updated.
  const sessionExpired = useSearchParams().get(SESSION_EXPIRED_PARAM) === '1';

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    setValue,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormInput, unknown, LoginFormValues>({
    resolver: zodResolver(loginSchema, authParseOptions),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values);
    } catch (error) {
      if (applyApiFieldErrors(error, setError)) {
        const field = firstServerErrorField(error);
        if (field) setFocus(field as keyof LoginFormInput);
        return;
      }
      setFormError(describeAuthError(error));
      // A wrong password is the likely slip, so put the cursor where the fix goes.
      if (hasErrorCode(error, ERROR_CODES.INVALID_CREDENTIALS)) setFocus('password', { shouldSelect: true });
    }
  });

  const fillDemoAccount = () => {
    setFormError(null);
    clearErrors();
    setValue('email', DEMO_ACCOUNT.email, { shouldDirty: true });
    setValue('password', DEMO_ACCOUNT.password, { shouldDirty: true });
    // Filling is a means to an end: land on the button that finishes the job.
    submitRef.current?.focus();
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {formError ? (
        <Alert tone={formError.tone} title={formError.title}>
          {formError.message}
        </Alert>
      ) : sessionExpired ? (
        <Alert tone="info" title="Your session has ended">
          For your security you were signed out. Sign in again to carry on where you left off; a booking you were
          filling in is kept.
        </Alert>
      ) : null}

      <FormField label="Email" error={errors.email?.message} required>
        <Input type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} {...register('email')} />
      </FormField>

      <PasswordField
        label="Password"
        autoComplete="current-password"
        error={errors.password?.message}
        required
        {...register('password')}
      />

      <Button ref={submitRef} type="submit" size="lg" fullWidth loading={isSubmitting}>
        {isSubmitting ? 'Signing in' : 'Sign in'}
      </Button>

      <div className="space-y-3 border-t border-border pt-5">
        <Button variant="secondary" fullWidth onClick={fillDemoAccount} disabled={isSubmitting}>
          Use demo account
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Fills in the {DEMO_ACCOUNT.businessName} customer login.
        </p>
      </div>
    </form>
  );
}
