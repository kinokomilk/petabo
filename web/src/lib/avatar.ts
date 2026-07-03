// 担当アバターのイニシャル（先頭1文字）。色は UserDTO.color を使う。
export function initial(name: string): string {
  const trimmed = (name || "").trim();
  return trimmed ? Array.from(trimmed)[0] : "?";
}
