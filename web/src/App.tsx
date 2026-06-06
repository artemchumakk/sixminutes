import { useState } from "react";
import type { ServiceId } from "./lib/types";
import { getWorkspace } from "./lib/workspaces";
import WorkspaceSelect from "./components/WorkspaceSelect";
import CodexApp from "./components/CodexApp";

export default function App() {
  const [service, setService] = useState<ServiceId | null>(null);

  if (!service) return <WorkspaceSelect onEnter={setService} />;
  return <CodexApp ws={getWorkspace(service)} onExit={() => setService(null)} />;
}
