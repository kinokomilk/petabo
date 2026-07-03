// 設定：メンバー一覧、招待リンク発行/失効（オーナーのみ）、メンバー削除、ログアウト。
import { useState } from "react";
import type { UserDTO, InviteDTO, TagDTO } from "../../../src/types";
import { useAuth } from "../auth/AuthContext";
import { endpoints } from "../api/endpoints";
import { useAsync } from "../lib/useAsync";
import { TopBar } from "../components/TopBar";
import { Avatar } from "../components/Avatar";
import { Spinner } from "../components/bits";
import "../components/forms.css";
import "./SettingsScreen.css";

const TAG_COLORS = [
  "#FF7A4D",
  "#4C8DF6",
  "#3AA675",
  "#9B7EDE",
  "#E86FA0",
  "#F4B740",
  "#2AA7A1",
  "#E25C5C",
  "#5F6FD8",
  "#7A7164",
];

export function SettingsScreen() {
  const { me, logout } = useAuth();
  const isOwner = me?.membership?.role === "owner";
  const meId = me?.user?.id ?? null;
  const lineLinked = me?.lineLinked ?? false;

  const users = useAsync<UserDTO[]>(() => endpoints.users(), []);
  const tags = useAsync<TagDTO[]>(() => endpoints.tags(), []);
  const [invite, setInvite] = useState<InviteDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#4C8DF6");
  const [tagError, setTagError] = useState<string | null>(null);

  const inviteUrl = invite
    ? `${window.location.origin}${invite.joinPath}`
    : null;

  async function makeInvite() {
    setBusy(true);
    try {
      const i = await endpoints.createInvite();
      setInvite(i);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!invite) return;
    setBusy(true);
    try {
      await endpoints.revokeInvite(invite.token);
      setInvite(null);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // クリップボード不可環境では何もしない（表示済みリンクを手動コピー）
    }
  }

  async function removeMember(u: UserDTO) {
    if (!window.confirm(`${u.displayName} さんを削除しますか？`)) return;
    await endpoints.removeMember(u.id);
    users.reload();
  }

  async function addTag() {
    const name = tagName.trim();
    if (!name || busy) return;
    setBusy(true);
    setTagError(null);
    try {
      await endpoints.createTag({ name, color: tagColor });
      setTagName("");
      tags.reload();
    } catch (error) {
      setTagError(error instanceof Error ? error.message : "カテゴリを追加できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(tag: TagDTO) {
    if (!window.confirm(`カテゴリ「${tag.name}」を削除しますか？`)) return;
    await endpoints.deleteTag(tag.id);
    tags.reload();
  }

  return (
    <div className="settings">
      <TopBar title="設定" backTo="/" backLabel="トップへ戻る" />
      <div className="settings-body">
        <section className="settings-block">
          <h2 className="settings-h">
            {me?.household?.name ?? "家族"} のメンバー
          </h2>
          {users.loading ? (
            <Spinner />
          ) : (
            <ul className="member-list">
              {(users.data ?? []).map((u) => (
                <li className="member-row" key={u.id}>
                  <Avatar name={u.displayName} color={u.color} size={32} />
                  <span className="member-name">
                    {u.displayName}
                    {u.id === meId && <span className="member-you">（あなた）</span>}
                  </span>
                  {isOwner && u.id !== meId && (
                    <button
                      className="btn btn-danger btn-sm ptb-press"
                      onClick={() => removeMember(u)}
                    >
                      削除
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {isOwner && (
          <section className="settings-block">
            <h2 className="settings-h">招待リンク</h2>
            {invite ? (
              <>
                <div className="invite-url">{inviteUrl}</div>
                <div className="invite-actions">
                  <button
                    className="btn btn-primary btn-sm ptb-press"
                    onClick={() => void copy()}
                  >
                    {copied ? "コピーしました" : "リンクをコピー"}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm ptb-press"
                    onClick={() => void revoke()}
                    disabled={busy}
                  >
                    失効する
                  </button>
                </div>
                <p className="form-note">
                  このリンクを家族に送ると、名前とパスワードで参加できます。
                </p>
              </>
            ) : (
              <button
                className="btn btn-primary btn-block ptb-press"
                onClick={() => void makeInvite()}
                disabled={busy}
              >
                招待リンクを発行
              </button>
            )}
          </section>
        )}

        <section className="settings-block">
          <h2 className="settings-h">LINE 連携</h2>
          {lineLinked ? (
            <p className="form-note">
              LINE と連携済みです。期限が近いタスクを LINE に通知します。
            </p>
          ) : (
            <>
              <a className="btn btn-line btn-block ptb-press" href="/api/auth/line/start">
                <span className="btn-line-icon" aria-hidden="true">
                  LINE
                </span>
                LINE と連携する
              </a>
              <p className="form-note">
                連携すると、担当タスクの期限が近づいたときに LINE で通知を受け取れます。
              </p>
            </>
          )}
        </section>

        <section className="settings-block">
          <h2 className="settings-h">カテゴリ</h2>
          <div className="tag-list">
            {(tags.data ?? []).map((tag) => (
              <div className="tag-row" key={tag.id}>
                <span className="cat-dot" style={{ background: tag.color }} />
                <span className="tag-name">{tag.name}</span>
                <button
                  type="button"
                  className="tag-delete"
                  aria-label={`カテゴリ「${tag.name}」を削除`}
                  onClick={() => void removeTag(tag)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="tag-create">
            <input
              className="input"
              aria-label="新しいカテゴリ名"
              placeholder="カテゴリ名"
              maxLength={40}
              value={tagName}
              onChange={(event) => setTagName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addTag();
                }
              }}
            />
            <div className="tag-colors" role="group" aria-label="カテゴリの色">
              {TAG_COLORS.map((color) => (
                <button
                  type="button"
                  key={color}
                  className={`tag-color ${tagColor === color ? "active" : ""}`}
                  style={{ background: color }}
                  aria-label={`色 ${color}`}
                  aria-pressed={tagColor === color}
                  onClick={() => setTagColor(color)}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm ptb-press"
              onClick={() => void addTag()}
              disabled={busy || !tagName.trim()}
            >
              追加
            </button>
          </div>
          {tagError && <p className="form-error">{tagError}</p>}
        </section>

        <section className="settings-block">
          <button
            className="btn btn-ghost btn-block ptb-press"
            onClick={() => logout()}
          >
            ログアウト
          </button>
        </section>
      </div>
    </div>
  );
}
