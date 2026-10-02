import bcrypt from 'bcryptjs';

/**
 * Cost 12: roughly 250ms on modern hardware. High enough that an offline attack
 * on a leaked table is expensive, low enough that login stays responsive.
 *
 * bcryptjs (pure JS) over the native `bcrypt` binding on purpose: native
 * modules need a toolchain at install time, which is a recurring source of
 * broken container builds on hosts that ship a slim base image.
 */
const COST = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, COST);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

/**
 * Burn a comparable amount of time when the email does not exist.
 *
 * Without this, "no such user" returns in ~1ms while "wrong password" takes
 * ~250ms, and the timing difference alone would make login reveal which emails
 * are registered — defeating the point of returning an identical error message
 * for both. It closes the login channel only: signup's "email taken" answer is
 * a deliberate, rate-limited exception (see auth/service.ts).
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.6oVZsZ9dXzBEBcvF7hGHRvGDBX0L1Vy';
export const equalizeTiming = (): Promise<boolean> =>
  bcrypt.compare('timing-equalizer', DUMMY_HASH);
