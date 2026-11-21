import { type LanguageModel, simulateReadableStream } from 'ai';

/**
 * An offline AI SDK language model: it streams `text` as word deltas, with no
 * provider, no network and no API key.
 *
 * It honors the call's abort signal the way a hosted provider does. From AI
 * SDK 7, `streamText` leaves stopping the model's stream to the provider, so a
 * client that disconnects only stops a model that listens to the signal.
 *
 * This is the part of `@nest-native/ai-sdk/testing`'s `createMockLanguageModel`
 * the app used, kept here since that package was retired. It emits the AI
 * SDK's v4 stream protocol: `stream-start`, `text-start`, one `text-delta` per
 * word, `text-end`, then a `stop` finish.
 */
export function createOfflineModel(text: string): LanguageModel {
  const deltas = text
    .split(' ')
    .map((word, index) => (index === 0 ? word : ` ${word}`));
  const parts: Record<string, unknown>[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    ...deltas.map((delta) => ({ type: 'text-delta', id: '1', delta })),
    { type: 'text-end', id: '1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
        outputTokens: {
          total: deltas.length,
          text: deltas.length,
          reasoning: 0,
        },
      },
    },
  ];

  const model = {
    specificationVersion: 'v4',
    provider: 'offline',
    modelId: 'project-digest',
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('The offline model only streams.');
    },
    doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
      stream: stopOnAbort(simulateReadableStream({ chunks: parts }), abortSignal),
    }),
  };

  return model as unknown as LanguageModel;
}

/** `source`, cancelled as soon as `signal` aborts (at once when it already has). */
function stopOnAbort<T>(
  source: ReadableStream<T>,
  signal: AbortSignal | undefined,
): ReadableStream<T> {
  const reader = source.getReader();
  const stop = (): void => {
    void reader.cancel(signal?.reason);
  };
  if (signal?.aborted) {
    stop();
  } else {
    signal?.addEventListener('abort', stop, { once: true });
  }

  return new ReadableStream<T>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        signal?.removeEventListener('abort', stop);
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      signal?.removeEventListener('abort', stop);
      return reader.cancel(reason);
    },
  });
}
