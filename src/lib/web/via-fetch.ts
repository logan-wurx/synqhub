// How the website fetches VIA keyboard layouts from usevia.app.
//
// CORS: usevia.app serves /definitions/<v2|v3>/<id>.json with `Access-Control-Allow-Origin: *`
// (checked 2026-10-14), so a plain GET from any origin works. Its OPTIONS answer is 405, so the request
// must stay a "simple" one: no custom headers, and `cache: "no-cache"` (which some browsers turn into a
// conditional-request header) is dropped. If the fetch is blocked anyway (offline, a content blocker, a
// proxy), the panel says so in plain words instead of guessing: see `problem()` in src/lib/kb/web-host.ts.
import { VIA_DEFINITIONS_URL } from "../kb/via/definitions.ts";

/** `fetch` for usevia.app: a simple request (no preflight), and the reason when it can't be made. */
export function viaFetcher(onProblem: (why: string | null) => void, base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return async (input, init) => {
    const { cache: _cache, ...rest } = init ?? {};
    void _cache;
    try {
      const res = await base(input, { ...rest, cache: "default" });
      onProblem(res.ok || res.status === 404 ? null : `usevia.app answered ${res.status}`);
      return res;
    } catch (e) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      onProblem(
        offline
          ? "This browser is offline, so VIA's keyboard list (usevia.app) couldn't be asked for this board's layout"
          : `The browser couldn't reach VIA's keyboard list (${VIA_DEFINITIONS_URL.replace("https://", "")}): it may be offline or blocked by an extension or network`,
      );
      throw e;
    }
  };
}
