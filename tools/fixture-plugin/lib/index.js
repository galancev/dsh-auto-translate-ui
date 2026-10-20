/**
 * Host half of the verification fixture plugin.
 *
 * Deliberately tiny: one exact HTTP route registered on the web server carrier.
 * It proves that `dsh plugin add` installed the package, that the profile bundle
 * layer mounted the Loader row, and that host code runs inside the isolated
 * `dsh web` instance. The route is a plain named route (not the authenticated
 * `/api` channel), which keeps the probe independent of browser cookies.
 */

/** Stable Cordis plugin name. */
export const name = "fixture-plugin";

/** Mount only once the web server carrier exists (web profile). */
export const inject = ["webServer"];

/** The one GET route this fixture owns. */
export const ROUTE = "/fixture/hello";

/** The one POST route this fixture owns (доказывает работу JSON-POST в probe). */
export const ECHO_ROUTE = "/fixture/echo";

/**
 * Register the fixture routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: ROUTE,
        handler: (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD" });
            res.end();
            return;
          }
          const body = `${JSON.stringify({
            ok: true,
            plugin: name,
            route: ROUTE,
            pid: process.pid,
          })}\n`;
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(req.method === "HEAD" ? undefined : body);
        },
      }),
    "fixture-plugin: host route",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: ECHO_ROUTE,
        handler: (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405, { allow: "POST" });
            res.end();
            return;
          }
          let raw = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on("end", () => {
            let received;
            try {
              received = JSON.parse(raw);
            } catch {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(`${JSON.stringify({ ok: false, error: "body is not JSON" })}\n`);
              return;
            }
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(`${JSON.stringify({ ok: true, plugin: name, route: ECHO_ROUTE, received })}\n`);
          });
        },
      }),
    "fixture-plugin: POST echo route",
  );
}
