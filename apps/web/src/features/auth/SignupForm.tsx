'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES } from '@appt/shared';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { hasErrorCode } from '@/lib/api';
import { applyApiFieldErrors } from '@/lib/form-errors';
import { useAuth } from '@/providers/AuthProvider';
import { describeAuthError, firstServerErrorField, type AuthFormError } from './auth-errors';
import { BusinessModeChoice } from './BusinessModeChoice';
import { authParseOptions } from './error-map';
import { PasswordChecklist } from './PasswordChecklist';
import { PasswordField } from './PasswordField';
import { signupFormSchema, toSignupInput, type SignupFormInput, type SignupFormValues } from './signup-schema';

/**
 * Account creation. Like LoginForm it leaves the redirect to GuestGuard once
 * AuthProvider reports a signed-in user.
 */
export function SignupForm() {
  const { signup } = useAuth();
  const [formError, setFormError] = useState<AuthFormError | null>(null);
  const checklistId = useId();

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormInput, unknown, SignupFormValues>({
    resolver: zodResolver(signupFormSchema, authParseOptions),
    defaultValues: {
      fullName: '',
      email: '',
      password: '',
      phone: '',
      mode: 'create',
      businessName: '',
      businessSlug: '',
    },
  });

  const mode = watch('mode');
  const password = watch('password');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signup(toSignupInput(values));
    } catch (error) {
      if (hasErrorCode(error, ERROR_CODES.EMAIL_TAKEN)) {
        setError('email', { type: 'server', message: 'An account with this email already exists. Try signing in instead.' });
        setFocus('email');
        return;
      }
      if (applyApiFieldErrors(error, setError)) {
        const field = firstServerErrorField(error);
        if (field) setFocus(field as keyof SignupFormInput);
        return;
      }
      setFormError(describeAuthError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {formError ? (
        <Alert tone={formError.tone} title={formError.title}>
          {formError.message}
        </Alert>
      ) : null}

      <FormField label="Full name" error={errors.fullName?.message} required>
        <Input autoComplete="name" {...register('fullName')} />
      </FormField>

      <FormField label="Email" error={errors.email?.message} required>
        <Input type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} {...register('email')} />
      </FormField>

      <div className="space-y-3">
        {/* No maxLength: it would silently cut a pasted password short, and the saved copy
            would then never sign in. The shared schema's byte limit reports it instead. */}
        <PasswordField
          label="Password"
          autoComplete="new-password"
          aria-describedby={checklistId}
          error={errors.password?.message}
          required
          {...register('password')}
        />
        <PasswordChecklist id={checklistId} value={password} />
      </div>

      <FormField label="Phone (optional)" hint="Only used by the business to reach you about a booking." error={errors.phone?.message}>
        <Input type="tel" autoComplete="tel" inputMode="tel" {...register('phone')} />
      </FormField>

      <div className="space-y-4">
        <BusinessModeChoice registration={register('mode')} />

        {mode === 'create' ? (
          <FormField
            label="Business name"
            hint="You will be the owner of this business."
            error={errors.businessName?.message}
            required
          >
            <Input autoComplete="organization" {...register('businessName')} />
          </FormField>
        ) : (
          <FormField
            label="Business code"
            hint="Lowercase letters, numbers and hyphens, for example bluewave. Ask the business if you are not sure."
            error={errors.businessSlug?.message}
            required
          >
            <Input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} {...register('businessSlug')} />
          </FormField>
        )}
      </div>

      <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
        {isSubmitting ? 'Creating account' : 'Create account'}
      </Button>
    </form>
  );
}
