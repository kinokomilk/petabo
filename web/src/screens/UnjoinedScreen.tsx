// 認証済だが未参加（joinState==='none'）。新規作成 / 招待コードで参加 / 別アカウント。
import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useRouter } from "../lib/router";
import { endpoints } from "../api/endpoints";
import { ApiError } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import "../components/forms.css";
import "./UnjoinedScreen.css";

// 招待リンク or トークン文字列のどちらでも token を抽出。
function extractToken(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  const m = v.match(/\/join\/([^/?#]+)/);
  if (m) return m[1];
  return v; // 生のトークン
}

export function UnjoinedScreen() {
  const { logout, refresh } = useAuth();
  const { navigate } = useRouter();
  const [code, setCode] = useState("");
  const [houseName, setHouseName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function goJoin() {
    const token = extractToken(code);
    if (token) navigate(`/join/${encodeURIComponent(token)}`);
  }

  async function createSpace() {
    const name = houseName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.createHousehold(name);
      await refresh();
      navigate("/");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "スペースを作成できませんでした"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unjoined-screen">
      <EmptyState
        kind="unjoined"
        action={
          <>
            {/* 新規作成：最初の人はここから家族スペースを作りオーナーになる。 */}
            <div className="create-space">
              <label htmlFor="house-name" className="create-space-label">
                新しい家族スペースを作る
              </label>
              <div className="join-code-row">
                <input
                  id="house-name"
                  className="input"
                  placeholder="サンプル家"
                  value={houseName}
                  onChange={(e) => setHouseName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createSpace();
                  }}
                  aria-label="家族スペースの名前"
                />
                <button
                  className="btn btn-primary btn-sm ptb-press"
                  onClick={() => void createSpace()}
                  disabled={busy || !houseName.trim()}
                >
                  作る
                </button>
              </div>
              {error && <div className="form-error">{error}</div>}
            </div>

            <div className="unjoined-or">または招待で参加</div>

            <div className="join-code-row">
              <input
                className="input"
                placeholder="招待リンク / コードを貼る"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goJoin();
                }}
                aria-label="招待リンクまたはコード"
              />
              <button
                className="btn btn-ghost btn-sm ptb-press"
                onClick={goJoin}
                disabled={!extractToken(code)}
              >
                参加
              </button>
            </div>

            <button
              className="btn btn-ghost btn-block ptb-press"
              onClick={() => logout()}
            >
              別のアカウントでログイン
            </button>
          </>
        }
      />
    </div>
  );
}
