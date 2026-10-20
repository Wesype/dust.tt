import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";

import { normalizeError } from "@app/types/shared/utils/error_utils";

// Define a type for the RequestInit object with duplex set to "half" because the official types are
// lagging behind.
export interface RequestInitWithDuplex extends RequestInit {
  duplex: "half";
}

export function readableStreamToReadable<T = unknown>(
  webStream: ReadableStream<T>
): Readable {
  return Readable.fromWeb(webStream as NodeReadableStream<T>);
}

/**
 * @cc [owner:davidebbo,label:error-handling] delayed-pipe-readable-cancellation
 * Cancelling before the first `pipe` event must drain the readable and delay destruction until
 * that event; cancelling after it must destroy the readable immediately.
 */
export function createReadableCancellationHandler(
  readable: Readable
): () => void {
  let pipeReceived = false;
  let cancelled = false;
  const onPipe = () => {
    pipeReceived = true;
  };
  readable.on("pipe", onPipe);

  return () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    readable.off("pipe", onPipe);
    readable.on("error", () => {});

    if (pipeReceived) {
      readable.destroy();
    } else {
      // GCS connects its upstream pipeline asynchronously. Draining lets that setup finish; the
      // listener then stops the transfer without triggering ERR_STREAM_UNABLE_TO_PIPE.
      readable.once("pipe", () => readable.destroy());
      readable.resume();
    }
  };
}

export function readableToReadableStream<T = unknown>(
  readable: Readable
): ReadableStream<T> {
  const cancelReadable = createReadableCancellationHandler(readable);

  return new ReadableStream<T>({
    start(controller) {
      readable.on("data", (chunk: T) => controller.enqueue(chunk));
      readable.on("end", () => controller.close());
      readable.on("error", (err) => controller.error(err));
    },
    cancel() {
      readable.removeAllListeners("data");
      readable.removeAllListeners("end");
      readable.removeAllListeners("error");
      readable.removeAllListeners("pipe");
      cancelReadable();
    },
  });
}

/**
 * @cc [owner:tdraier,label:error-handling] async-generator-stream-errors
 * A value is pulled from the generator only when the stream needs one. When the generator throws,
 * the stream MUST be errored (never closed), so an HTTP response built on it is aborted instead of
 * ending as if complete. Cancelling the stream MUST return the generator.
 */
export function asyncGeneratorToReadableStream<T>(
  generator: AsyncGenerator<T>,
  {
    highWaterMark,
    onError,
  }: { highWaterMark?: number; onError?: (error: Error) => void } = {}
): ReadableStream<T> {
  let cancelled = false;

  return new ReadableStream<T>(
    {
      async pull(controller) {
        try {
          const { value, done } = await generator.next();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          if (!cancelled) {
            const error = normalizeError(err);
            onError?.(error);
            controller.error(error);
          }
        }
      },
      async cancel() {
        cancelled = true;
        await generator.return(undefined);
      },
    },
    { highWaterMark }
  );
}
