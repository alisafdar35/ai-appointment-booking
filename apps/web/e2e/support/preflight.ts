import { request, type FullConfig } from '@playwright/test';

/**
 * Refuses to run against a stack that would make the suite nondeterministic.
 *
 * The specs assert on exact assistant behaviour (what a message is understood
 * as, which card follows), which only the rule-based engine guarantees. With a
 * Mistral key configured the same messages go to a model, and its wording and
 * readings vary between runs. Failing here, with the reason, beats a dozen
 * specs failing for no visible cause.
 */
export default async function preflight(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:3000';
  const context = await request.newContext({ baseURL });
  try {
    const response = await context.get('/api/health').catch(() => null);
    if (!response?.ok()) {
      throw new Error(`No healthy stack at ${baseURL}. Start the API and web app first (see playwright.config.ts).`);
    }
    const health = (await response.json()) as { aiProvider?: string };
    if (health.aiProvider !== 'fallback-only') {
      throw new Error(
        `The API is running with an AI provider ("${health.aiProvider}"). Start it with MISTRAL_API_KEY unset ` +
          '(see playwright.config.ts) so the assistant is the deterministic guided engine.',
      );
    }
  } finally {
    await context.dispose();
  }
}
