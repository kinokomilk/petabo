// ログイン / オーナー新規作成。タブ切替で1画面に集約。
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useRouter, Link } from "../lib/router";
import { endpoints } from "../api/endpoints";
import { ApiError } from "../api/client";
import "../components/forms.css";
import "./AuthScreen.css";

type Mode = "login" | "register";

export function AuthScreen({ initialMode = "login" }: { initialMode?: Mode }) {
  const { refresh } = useAuth();
  const { navigate } = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);

  const [householdName, setHouseholdName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // LINE ログイン callback 失敗時はサーバが ?error=line_login で戻す。
  // 優しいメッセージを表示し、URL からは error を消す（履歴をきれいに保つ）。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "line_login") {
      setError("LINE ログインに失敗しました。もう一度お試しください。");
      params.delete("error");
      const qs = params.toString();
      const clean = window.location.pathname + (qs ? `?${qs}` : "");
      window.history.replaceState({}, "", clean);
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") {
        await endpoints.register({ householdName, displayName, password });
      } else {
        await endpoints.login({ displayName, password });
      }
      await refresh();
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "うまくいきませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-brand">
        <span className="auth-logo">petabo</span>
        <span className="auth-tagline">やることを、ペタッと家族で。</span>
      </div>

      <div className="auth-tabs" role="tablist" aria-label="ログインまたは新規作成">
        <button
          id="auth-tab-login"
          role="tab"
          aria-selected={mode === "login"}
          aria-controls="auth-panel"
          className={`auth-tab ${mode === "login" ? "active" : ""}`}
          onClick={() => {
            setMode("login");
            setError(null);
          }}
        >
          ログイン
        </button>
        <button
          id="auth-tab-register"
          role="tab"
          aria-selected={mode === "register"}
          aria-controls="auth-panel"
          className={`auth-tab ${mode === "register" ? "active" : ""}`}
          onClick={() => {
            setMode("register");
            setError(null);
          }}
        >
          スペースを作る
        </button>
      </div>

      <form
        id="auth-panel"
        role="tabpanel"
        aria-labelledby={mode === "login" ? "auth-tab-login" : "auth-tab-register"}
        className="auth-form"
        onSubmit={submit}
      >
        {error && <div className="form-error">{error}</div>}

        {mode === "register" && (
          <div className="field">
            <label htmlFor="hh">家族の名前</label>
            <input
              id="hh"
              className="input"
              placeholder="サンプル家"
              value={householdName}
              onChange={(e) => setHouseholdName(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="name">あなたの名前</label>
          <input
            id="name"
            className="input"
            placeholder="まり"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="username"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="pw">パスワード</label>
          <input
            id="pw"
            className="input"
            type="password"
            placeholder="6文字以上"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            required
          />
        </div>

        <button
          className="btn btn-primary btn-block ptb-press"
          type="submit"
          disabled={busy}
        >
          {busy
            ? "..."
            : mode === "register"
              ? "スペースを作ってはじめる"
              : "ログイン"}
        </button>
      </form>

      <div className="auth-divider" role="separator">
        <span>または</span>
      </div>

      {/* SPEC §4: LINE ログインが主。サーバの認可開始エンドポイントへ遷移。 */}
      <a
        className="btn btn-line btn-block ptb-press"
        href="/api/auth/line/start"
      >
        <span className="btn-line-icon" aria-hidden="true">
          LINE
        </span>
        LINE でログイン
      </a>

      <p className="auth-help">
        招待リンクをお持ちですか？ そのリンクを開いて参加してください。
        <br />
        <Link to="/">トップへ戻る</Link>
      </p>
    </div>
  );
}
