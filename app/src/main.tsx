import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const path = window.location.pathname;
const query = new URLSearchParams(window.location.search);
// Old operator links (`/?token=…`, `/?backend=…`) pointed at the console when it lived at `/`.
const legacyConsole = path === "/" && (query.has("token") || query.has("backend"));
if (legacyConsole) window.location.replace(`/console${window.location.search}${window.location.hash}`);

const Page =
  path === "/join" || path.startsWith("/join/")
    ? lazy(() => import("./join/Join"))
    : path === "/" ? lazy(() => import("./landing/Landing"))
    : path === "/harta" ? lazy(() => import("./map/t2/MapPreview"))
    : path.startsWith("/m/") ? lazy(() => import("./me/Me"))
    : lazy(() => import("./App"));

if (!legacyConsole) createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
);
