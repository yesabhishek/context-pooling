import * as React from "react";
import type { ContextPack, HandoffListItem, UiStatus } from "../../types";
import { fetchHandoffs, fetchPacks, fetchStatus, fetchTasks, type TaskSummary } from "./api";

export type AppData = {
  state: "loading" | "ready" | "error";
  error?: string;
  status?: UiStatus;
  handoffs: HandoffListItem[];
  tasks: TaskSummary[];
  packs: ContextPack[];
  reload: () => Promise<void>;
  reloadPacks: () => Promise<void>;
};

const DataContext = React.createContext<AppData | undefined>(undefined);
const POLL_MS = 4_000;

/**
 * Loads everything the shell needs, then polls the cheap status endpoint so a `ctxpool handoff`
 * run in a terminal shows up without a reload.
 */
export function DataProvider({ children, onNewHandoff }: { children: React.ReactNode; onNewHandoff?: (handoff: HandoffListItem) => void }) {
  const [state, setState] = React.useState<AppData["state"]>("loading");
  const [error, setError] = React.useState<string>();
  const [status, setStatus] = React.useState<UiStatus>();
  const [handoffs, setHandoffs] = React.useState<HandoffListItem[]>([]);
  const [tasks, setTasks] = React.useState<TaskSummary[]>([]);
  const [packs, setPacks] = React.useState<ContextPack[]>([]);
  const statusRef = React.useRef<UiStatus | undefined>(undefined);
  const notifyRef = React.useRef(onNewHandoff);
  notifyRef.current = onNewHandoff;

  const reload = React.useCallback(async () => {
    try {
      const [nextStatus, nextHandoffs, nextTasks, nextPacks] = await Promise.all([fetchStatus(), fetchHandoffs(), fetchTasks(), fetchPacks()]);
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setHandoffs(nextHandoffs);
      setTasks(nextTasks);
      setPacks(nextPacks);
      setError(undefined);
      setState("ready");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not reach the ContextPool server.");
      setState((current) => (current === "ready" ? current : "error"));
    }
  }, []);

  const reloadPacks = React.useCallback(async () => {
    setPacks(await fetchPacks());
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  React.useEffect(() => {
    if (state !== "ready") return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const next = await fetchStatus();
        const previous = statusRef.current;
        if (cancelled) return;
        if (previous && (next.latestAt !== previous.latestAt || next.handoffCount !== previous.handoffCount)) {
          const [nextHandoffs, nextTasks] = await Promise.all([fetchHandoffs(), fetchTasks()]);
          if (cancelled) return;
          setHandoffs(nextHandoffs);
          setTasks(nextTasks);
          if (next.handoffCount > previous.handoffCount && nextHandoffs[0]) notifyRef.current?.(nextHandoffs[0]);
        }
        if (previous && next.packCount !== previous.packCount) setPacks(await fetchPacks());
        statusRef.current = next;
        setStatus(next);
        setError(undefined);
      } catch (pollError) {
        if (!cancelled) setError(pollError instanceof Error ? pollError.message : "Lost connection");
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state]);

  const value = React.useMemo<AppData>(() => ({ state, error, status, handoffs, tasks, packs, reload, reloadPacks }), [state, error, status, handoffs, tasks, packs, reload, reloadPacks]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): AppData {
  const value = React.useContext(DataContext);
  if (!value) throw new Error("useData needs a DataProvider");
  return value;
}
