import type { UserDTO } from "../../../src/types";
import { Avatar } from "./Avatar";
import "./Avatar.css";

// メンバーアバターの集合（横並び＋ +N で省略）。重なり表示は使わず横並び＋白縁。
export function AvatarStack({
  users,
  max = 3,
  size = 26,
}: {
  users: UserDTO[];
  max?: number;
  size?: number;
}) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <div className="avatar-stack">
      {shown.map((u) => (
        <Avatar key={u.id} name={u.displayName} color={u.color} size={size} ring />
      ))}
      {rest > 0 && (
        <span
          className="avatar-more"
          style={{ width: size, height: size }}
          aria-label={`他 ${rest} 名`}
        >
          +{rest}
        </span>
      )}
    </div>
  );
}
