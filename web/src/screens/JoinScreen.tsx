// 招待リンク参加 /join/:token。token 検証 → 名前+パスワードで参加。
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useRouter, Link } from "../lib/router";
import { endpoints } from "../api/endpoints";
import { ApiError } from "../api/client";
import { Spinner } from "../components/bits";
import "../components/forms.css";
import "./AuthScreen.css";

export function JoinScreen({ token }: { token: string }) {
  const { refresh } = useAuth();
  const { navigate } = useRouter();

  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    endpoints
      .checkInvite(token)
      .then((r) => {
        if (alive) setValid(!!r.valid);
      })
      .catch(() => {
        if (alive) setValid(false);
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await endpoints.join(token, { displayName, password });
      await refresh();
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "参加できませんでした");
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="auth-screen">
        <Spinner label="招待を確認中" />
      </div>
    );
  }

  if (!valid) {
    return (
      <div className="auth-screen">
        <div className="auth-brand">
          <span className="auth-logo">petabo</span>
        </div>
        <div className="form-error" style={{ textAlign: "center" }}>
          この招待リンクは無効か、期限が切れています。
        </div>
        <p className="auth-help">
          家族にもう一度リンクを発行してもらってください。
          <br />
          <Link to="/">トップへ戻る</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-brand">
        <span className="auth-logo">petabo</span>
        <span className="auth-tagline">家族のスペースに参加します</span>
      </div>

      {/* SPEC §4: LINE ログインが主。招待トークンを引き継いで参加させる。 */}
      <a
        className="btn btn-line btn-block ptb-press"
        href={`/api/auth/line/start?invite=${encodeURIComponent(token)}`}
      >
        <span className="btn-line-icon" aria-hidden="true">
          LINE
        </span>
        LINE で参加
      </a>

      <div className="auth-divider" role="separator">
        <span>または 名前とパスワードで</span>
      </div>

      <form className="auth-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="jname">あなたの名前</label>
          <input
            id="jname"
            className="input"
            placeholder="けん"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="jpw">パスワード</label>
          <input
            id="jpw"
            className="input"
            type="password"
            placeholder="6文字以上"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <span className="form-note">
            次回からはこの名前とパスワードでログインできます。
          </span>
        </div>
        <button
          className="btn btn-primary btn-block ptb-press"
          type="submit"
          disabled={busy}
        >
          {busy ? "..." : "参加する"}
        </button>
      </form>
    </div>
  );
}
