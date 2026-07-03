import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "./auth/AuthContext";
import { RouterProvider } from "./lib/router";
import { App } from "./App";
import "./styles/global.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider>
      <AuthProvider>
        <div className="app-shell">
          <App />
        </div>
      </AuthProvider>
    </RouterProvider>
  </StrictMode>
);

// PWA: 本番のみ Service Worker を登録（dev では無効化してキャッシュ事故を避ける）。
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 登録失敗は致命的でない（オフラインシェルが効かないだけ）
    });
  });
}
