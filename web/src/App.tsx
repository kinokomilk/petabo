// ルート分岐。認証状態（loading/anonymous/unjoined/active）とパスで画面を切替。
import { useAuth } from "./auth/AuthContext";
import { useRouter, matchJoin, matchTodo } from "./lib/router";
import { Spinner } from "./components/bits";
import { AuthScreen } from "./screens/AuthScreen";
import { JoinScreen } from "./screens/JoinScreen";
import { UnjoinedScreen } from "./screens/UnjoinedScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { NewTodoScreen } from "./screens/NewTodoScreen";
import { TodoDetailScreen } from "./screens/TodoDetailScreen";
import { ChecklistDetailScreen } from "./screens/ChecklistDetailScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

function matchChecklist(path: string): string | null {
  const m = path.match(/^\/checklists\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const { status } = useAuth();
  const { path } = useRouter();

  // /join/:token は認証状態に関わらず最優先（招待からの新規参加）。
  const joinToken = matchJoin(path);
  if (joinToken) return <JoinScreen token={joinToken} />;

  if (status === "loading") {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
        <Spinner label="読み込み中" />
      </div>
    );
  }

  if (status === "anonymous") {
    return <AuthScreen initialMode="login" />;
  }

  if (status === "unjoined") {
    return <UnjoinedScreen />;
  }

  // active（参加済）
  const todoId = matchTodo(path);
  if (todoId) return <TodoDetailScreen todoId={todoId} />;

  const checklistId = matchChecklist(path);
  if (checklistId) return <ChecklistDetailScreen todoId={checklistId} />;

  if (path === "/new") return <NewTodoScreen />;
  if (path === "/settings") return <SettingsScreen />;

  return <HomeScreen />;
}
