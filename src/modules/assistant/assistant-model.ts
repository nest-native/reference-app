import type { LanguageModel } from 'ai';
import { createMockLanguageModel } from '@nest-native/ai-sdk/testing';

/**
 * Selects the language model backing the project assistant.
 *
 * - **Default (and always in CI):** the offline `createMockLanguageModel` from
 *   `@nest-native/ai-sdk/testing`, which replays the digest we built from the
 *   activity feed as word deltas. Deterministic, no network, no API key — and
 *   `respectAbortSignal` tears the stream down on client disconnect exactly as
 *   a hosted provider would.
 * - **Real provider (config-gated):** when `OPENAI_API_KEY` is set, use
 *   OpenAI's `gpt-4o-mini` through the OPTIONAL `@ai-sdk/openai` dependency.
 *   It is imported lazily so neither the key nor the package is required on the
 *   mock path — CI stays offline and hermetic.
 *
 * Swapping providers is therefore purely a matter of configuration: set the key
 * (and keep the optional dependency installed) and the same endpoint streams
 * real completions.
 */
export async function resolveAssistantModel(
  summary: string,
): Promise<LanguageModel> {
  if (process.env.OPENAI_API_KEY) {
    const { openai } = await import('@ai-sdk/openai');
    return openai('gpt-4o-mini');
  }
  return createMockLanguageModel({ text: summary, respectAbortSignal: true });
}
