import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const Page =
  window.location.pathname === "/join" ||
  window.location.pathname.startsWith("/join/")
    ? lazy(() => import("./join/Join"))
    : window.location.pathname === "/harta" ? lazy(() => import("./map/t2/MapPreview"))
    : window.location.pathname.startsWith("/m/") ? lazy(() => import("./me/Me"))
    : lazy(() => import("./App"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
);
