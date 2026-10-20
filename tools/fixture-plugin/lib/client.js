/**
 * Browser half of the verification fixture plugin.
 *
 * The wrapper below is the exact lazily-registered factory format the DSH module
 * system expects (`window.__ModuleLoader__.load({ id, factory })`, factory-form
 * CJS). `id` must equal the package name, because the host half of
 * `@deepseek-ai/dsh-client-modules` derives the served bundle id from the
 * package manifest of the Loader row.
 *
 * The factory only registers a factory; every side effect lives inside it and
 * runs at materialization. A successful boot sets `data-fixture-plugin` on
 * <html>, which tools/smoke-dom.mjs can assert in a real page.
 */
window.__ModuleLoader__.load({
  id: "dsh-fixture-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** Mark the document so a DOM smoke test can prove the browser half ran. */
    function apply(ctx) {
      try {
        if (typeof document !== "undefined") {
          document.documentElement.setAttribute("data-fixture-plugin", "loaded");
        }
        ctx.logger?.info?.("fixture-plugin: browser half mounted");
      } catch (error) {
        // A fixture must never break the shell it is verified against.
        ctx.logger?.warn?.(`fixture-plugin: browser half failed: ${String(error)}`);
      }
    }

    exports.name = "fixture-plugin-client";
    exports.apply = apply;
    return module.exports;
  },
});
