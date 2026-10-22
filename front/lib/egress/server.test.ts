import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { refuseBrotliInterceptor } from "@app/lib/egress/server";
import logger from "@app/logger/logger";
import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const BODY = "hello from the egress test";

describe("refuseBrotliInterceptor", () => {
  let server: Server;
  let baseUrl: string;
  let lastRequestHeaders: IncomingHttpHeaders = {};
  const dispatcher = new Agent().compose(refuseBrotliInterceptor);

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastRequestHeaders = req.headers;
      if (req.url === "/br") {
        res.writeHead(200, { "content-encoding": "br" });
        res.end(brotliCompressSync(BODY));
      } else {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync(BODY));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server has no port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await dispatcher.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses a Brotli response even though the request did not ask for it", async () => {
    await expect(
      undiciFetch(`${baseUrl}/br`, { dispatcher })
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("Content-Encoding: br") },
    });
    expect(lastRequestHeaders["accept-encoding"]).toBe("gzip, deflate");
  });

  it("logs the host of a refused response", async () => {
    const warn = vi.spyOn(logger, "warn");
    await undiciFetch(`${baseUrl}/br`, { dispatcher }).catch(() => undefined);
    expect(warn).toHaveBeenCalledWith(
      { host: new URL(baseUrl).host },
      "Refused a Brotli-encoded egress response"
    );
    warn.mockRestore();
  });

  it("decodes a gzip response", async () => {
    const response = await undiciFetch(`${baseUrl}/gzip`, { dispatcher });
    expect(await response.text()).toBe(BODY);
  });

  it("overrides a caller-provided Accept-Encoding", async () => {
    await undiciFetch(`${baseUrl}/gzip`, {
      dispatcher,
      headers: { "Accept-Encoding": "br" },
    });
    expect(lastRequestHeaders["accept-encoding"]).toBe("gzip, deflate");
  });
});
