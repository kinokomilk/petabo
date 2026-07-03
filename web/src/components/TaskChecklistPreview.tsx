import type { ChecklistItemDTO } from "../../../src/types";
import { Checkbox } from "./Checkbox";

export function TaskChecklistPreview({
  items,
  onToggle,
}: {
  items: ChecklistItemDTO[];
  onToggle: (item: ChecklistItemDTO) => void;
}) {
  if (!items.length) return null;

  return (
    <div className="task-checklist" aria-label="チェック項目">
      {items.map((item) => (
        <div className="task-checklist-item" key={item.id}>
          <Checkbox
            checked={item.done}
            onToggle={() => onToggle(item)}
            variant="square"
            size={20}
            label={`${item.text} を${item.done ? "未完了" : "完了"}にする`}
          />
          <span className={`task-checklist-text ${item.done ? "done" : ""}`}>
            {item.text}
          </span>
        </div>
      ))}
    </div>
  );
}
