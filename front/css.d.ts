// Must come before "*.css": TypeScript resolves equally specific wildcards in declaration order.
declare module "*.print.css" {
  const css: string;
  export default css;
}

declare module "*.css";
