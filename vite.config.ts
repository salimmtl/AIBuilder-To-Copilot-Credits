import { defineConfig, type Plugin } from "vite";

/**
 * PPTB loads dist/index.html directly inside a BrowserView — there is no dev server
 * and no module loader. Vite's default output (an ES module script in <head>, with
 * crossorigin and root-absolute asset URLs) silently fails to run there.
 *
 * This rewrites the emitted HTML to what PPTB requires: plain <script> tags with no
 * type="module" or crossorigin, relative URLs, and scripts at the end of <body> so the
 * DOM exists before the IIFE executes.
 */
function pptbHtml(): Plugin {
  return {
    name: "pptb-html-output",
    enforce: "post",
    transformIndexHtml(html) {
      const scripts: string[] = [];

      let out = html.replace(
        /[ \t]*<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>\s*/g,
        (_match, src: string) => {
          scripts.push(src.startsWith("/") ? "." + src : src);
          return "";
        }
      );

      // Stylesheets can stay in <head>, but must lose crossorigin and stay relative.
      out = out.replace(/(<link\b[^>]*?)\s+crossorigin(="[^"]*")?/g, "$1");
      out = out.replace(/(<link\b[^>]*\bhref=")\/(?!\/)/g, "$1./");

      if (!scripts.length) return out;
      const tags = scripts.map((s) => `    <script src="${s}"></script>`).join("\n");
      return out.replace(/([ \t]*)<\/body>/, `${tags}\n$1</body>`);
    },
  };
}

export default defineConfig((configEnv) => {
  return {
    base: "./",
    root: "./src",
    plugins: [pptbHtml()],
    build: {
      outDir: "../dist",
      assetsDir: "assets",
      emptyOutDir: true,
      cssCodeSplit: false,
      sourcemap: configEnv.mode === "development",
      rollupOptions: {
        output: {
          // Single IIFE bundle: no ES module resolution happens at runtime in PPTB.
          format: "iife",
          entryFileNames: "app.js",
          assetFileNames: "assets/[name][extname]",
        },
      },
    },
  };
});
