import * as React from "react";

export type Route = { path: string[]; query: URLSearchParams };

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [pathname, search = ""] = raw.split("?");
  return { path: pathname.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(search) };
}

/** Hash routing keeps deep links working from the single-file server without route config. */
export function useRoute(): Route {
  const [route, setRoute] = React.useState(() => parse(window.location.hash));
  React.useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) if (value) params.set(key, value);
  const search = params.toString();
  return `#${path}${search ? `?${search}` : ""}`;
}

export function navigate(path: string, query?: Record<string, string | undefined>, options: { replace?: boolean } = {}): void {
  const next = href(path, query);
  if (options.replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
