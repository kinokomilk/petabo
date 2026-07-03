import { initial } from "../lib/avatar";
import "./Avatar.css";

interface AvatarProps {
  name: string;
  color: string;
  size?: number; // px
  ring?: boolean; // 集合表示の白縁
}

// 人＝フラット色丸＋イニシャル（petabo の核）。
export function Avatar({ name, color, size = 20, ring = false }: AvatarProps) {
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: Math.round(size * 0.5),
        border: ring ? "2px solid var(--bg)" : "none",
      }}
      aria-hidden="true"
    >
      {initial(name)}
    </span>
  );
}
