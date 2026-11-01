import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const path = window.location.pathname;
const query = new URLSearchParams(window.location.search);
// The console lived at `/`: old operator links (`/?token=…`, `/?backend=…`) and browsers that already hold an
// operator token or backend override still land on it. `/acasa` always shows the landing page.
const operator = () => { try { return Boolean(localStorage.getItem("clarion.token") || localStorage.getItem("clarion.backend")); } catch { return false; } };
const legacyConsole = path === "/" && (query.has("token") || query.has("backend") || operator());
if (legacyConsole) window.location.replace(`/console${window.location.search}${window.location.hash}`);

const Page =
  path === "/join" || path.startsWith("/join/")
    ? lazy(() => import("./join/Join"))
    : path === "/" || path === "/acasa" ? lazy(() => import("./landing/Landing"))
    : path === "/harta" ? lazy(() => import("./map/t2/MapPreview"))
    : path === "/harta/ruta" ? lazy(() => import("./map/t2/RouteRender"))
    : path.startsWith("/m/") ? lazy(() => import("./me/Me"))
    : lazy(() => import("./App"));

if (!legacyConsole) createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
);
