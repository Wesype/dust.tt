import { readFile } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

import { isString } from "@app/types/shared/utils/general";

export const PRINT_CSS_FILE_REGEX = /\.print\.css$/;

// A font's URL, relative to the stylesheet, as Tailwind writes it: unquoted.
const FONT_URL_REGEX = /url\((\.{1,2}\/[^)]+\.woff2)\)/g;

/**
 * Compiles a `*.print.css` file with Tailwind into minified CSS. The page prints with no network,
 * so its fonts are inlined as data URLs.
 */
export async function compilePrintCss(
  file: string
): Promise<{ css: string; dependencies: string[]; dependencyDirs: string[] }> {
  const result = await postcss([
    tailwindcss({ optimize: { minify: true } }),
  ]).process(await readFile(file, "utf8"), { from: file });

  const dependencies = result.messages.flatMap((message) =>
    message.type === "dependency" && isString(message.file)
      ? [message.file]
      : []
  );
  // A folder `@source` also depends on the files added to it.
  const dependencyDirs = result.messages.flatMap((message) =>
    message.type === "dir-dependency" && isString(message.dir)
      ? [message.dir]
      : []
  );

  const fontDataUrls = new Map<string, string>();
  for (const [, url] of result.css.matchAll(FONT_URL_REGEX)) {
    const fontFile = path.resolve(path.dirname(file), url);
    dependencies.push(fontFile);
    fontDataUrls.set(
      url,
      `url(data:font/woff2;base64,${(await readFile(fontFile)).toString("base64")})`
    );
  }
  const css = result.css.replace(
    FONT_URL_REGEX,
    (match, url: string) => fontDataUrls.get(url) ?? match
  );

  return { css, dependencies, dependencyDirs };
}
