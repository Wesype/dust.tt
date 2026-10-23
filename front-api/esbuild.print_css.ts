import type esbuild from "esbuild";

import {
  compilePrintCss,
  PRINT_CSS_FILE_REGEX,
} from "@app/scripts/css/print_css";

// `.print.css` imports are compiled with Tailwind, the module's default export being the CSS. Vitest
// stubs them, like any stylesheet, to an empty string.
export const printCssPlugin: esbuild.Plugin = {
  name: "print-css",
  setup(build) {
    build.onLoad({ filter: PRINT_CSS_FILE_REGEX }, async (args) => {
      const { css, dependencies, dependencyDirs } = await compilePrintCss(
        args.path
      );
      return {
        contents: css,
        loader: "text",
        watchFiles: dependencies,
        watchDirs: dependencyDirs,
      };
    });
  },
};
