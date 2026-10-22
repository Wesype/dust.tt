import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";

import { parseFrameSourceArchive } from "@app/lib/api/frames/source_archive";
import { buildFrameSourceTarArchive } from "@app/lib/api/frames/source_staging";
import { TarArchive } from "archiver";
import { describe, expect, it } from "vitest";

async function buildTar(
  entries: ReadonlyArray<{ name: string; content: string | Buffer }>
): Promise<Buffer> {
  const archive = new TarArchive({ gzip: false });
  const pass = new PassThrough();
  const chunks: Buffer[] = [];
  pass.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const done = finished(pass);
  archive.pipe(pass);
  for (const entry of entries) {
    archive.append(entry.content, { name: entry.name });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

const FILES = [
  { relativePath: "manifest.json", content: Buffer.from('{"name":"x"}') },
  {
    relativePath: "ui/components/App.tsx",
    content: Buffer.from("export const App = () => null;\n"),
  },
  {
    relativePath: "assets/logo.png",
    content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]),
  },
  { relativePath: "foo", content: Buffer.alloc(0) },
];

describe("parseFrameSourceArchive", () => {
  it("round-trips nested paths, binary content and empty files", async () => {
    const parsed = await parseFrameSourceArchive(
      await buildFrameSourceTarArchive(FILES)
    );

    expect(parsed.isOk()).toBe(true);
    if (parsed.isErr()) {
      return;
    }
    const byPath = new Map(
      parsed.value.map((file) => [file.relativePath, file.content])
    );
    expect([...byPath.keys()].sort()).toEqual(
      FILES.map((file) => file.relativePath).sort()
    );
    for (const file of FILES) {
      expect(byPath.get(file.relativePath)?.equals(file.content)).toBe(true);
    }
  });

  it("rejects an archive that is not a tar", async () => {
    const result = await parseFrameSourceArchive(Buffer.alloc(1024, 0x41));

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }
    expect(result.error).toContain("not a valid tar");
  });

  it("rejects an unsafe path", async () => {
    const tar = await buildTar([
      { name: "ui/App.tsx", content: "ok" },
      { name: "ui/../../escape.ts", content: "x" },
    ]);

    const result = await parseFrameSourceArchive(tar);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }
    expect(result.error).toContain("Unsafe path");
  });
});
