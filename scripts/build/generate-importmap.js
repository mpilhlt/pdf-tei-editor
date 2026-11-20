import { writeImportmaps } from "@jsenv/importmap-node-module";

const directoryUrl = new URL("./../..", import.meta.url);

// @ts-ignore
await writeImportmaps({
  directoryUrl,
  importmaps: {
    "./app/web/importmap.json": {
      importResolution: {
        entryPoints: ["./app/src/app.js", "./app/src/ui.js", "./app/src/manual.js", "./app/src/guide.js"],
      }
    }
  },
  packagesManualOverrides: {
    "react-redux": {
      exports: {
        import: "./es/index.js",
      }
    }
  }
});