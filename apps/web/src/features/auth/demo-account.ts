/**
 * The seeded customer from db/seed.sql. It is public on purpose: the landing
 * page advertises it and the sign-in form can fill it, so a reviewer can reach
 * a working session without registering first.
 */
export const DEMO_ACCOUNT = {
  email: 'customer@bluewave.test',
  password: 'Password123!',
  businessName: 'Bluewave Dental',
} as const;
