import { type LanguageModel, simulateReadableStream } from 'ai';

/**
 * An offline, deterministic language model that replays a pre-built status
 * update as a token stream. This is the CI-safe default: no network, no API
 * key, no provider dependency — so the assistant endpoint streams real
 * application data (the digest built from the activity feed) in tests and local
 * dev exactly as a hosted provider would.
 *
 * It implements just enough of the AI SDK's `specificationVersion: 'v4'`
 * language-model interface for `streamText` to drive it: `doStream` emits the
 * v4 stream-part protocol (`stream-start` → `text-start` → `text-delta`* →
 * `text-end` → `finish`) via the SDK's own `simulateReadableStream` helper. The
 * remaining members of the interface are never touched on the streaming path,
 * so the object is cast rather than fully implemented — the same shape the
 * ai-sdk samples use for their mock models.
 */
export function createMockSummaryModel(summary: string): LanguageModel {
  // Split into whitespace-preserving tokens so the concatenated deltas
  // reconstruct `summary` byte-for-byte on the client.
  const tokens = summary.split(/(\s+)/).filter((token) => token.length > 0);

  const model = {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-summary',
    supportedUrls: {},
    doStream: async () => ({
      stream: simulateReadableStream({
        // Zero delays keep the hermetic test fast and deterministic.
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          ...tokens.map((delta) => ({ type: 'text-delta', id: '1', delta })),
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: {
                total: 0,
                noCache: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: {
                total: tokens.length,
                text: tokens.length,
                reasoning: 0,
              },
            },
          },
        ],
      }),
    }),
  };

  return model as unknown as LanguageModel;
}
