// @vitest-environment node
import path from "node:path";
import { compilePrintCss } from "@app/scripts/css/print_css";
import { describe, expect, it } from "vitest";

const DOCUMENT_PRINT_CSS = path.resolve(
  __dirname,
  "../../lib/api/documents/document.print.css"
);

describe("compilePrintCss", () => {
  it("compiles the classes of its sources", async () => {
    const { css, dependencies, dependencyDirs } =
      await compilePrintCss(DOCUMENT_PRINT_CSS);

    expect(css).toContain(".my-2\\.5{");
    expect(css).toContain("--color-foreground:");
    expect(dependencies).toContain(
      path.resolve(__dirname, "../../components/editor/document/extensions.ts")
    );
    expect(dependencyDirs).toContain(
      path.resolve(__dirname, "../../components/editor/document")
    );
  });

  it("inlines its fonts", async () => {
    const { css, dependencies } = await compilePrintCss(DOCUMENT_PRINT_CSS);

    expect(css).toContain("url(data:font/woff2;base64,");
    expect(css).not.toMatch(/url\(\.\.?\//);
    expect(dependencies).toContain(
      path.resolve(__dirname, "../../public/static/fonts/GeistVariable.woff2")
    );
  });
});
