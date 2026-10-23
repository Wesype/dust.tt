// Mirrors the "*.print.css" declaration in front/css.d.ts. front-api deliberately does not include
// front/css.d.ts, so a plain .css import fails to typecheck instead of bundling as `{}`.
declare module "*.print.css" {
  const css: string;
  export default css;
}
