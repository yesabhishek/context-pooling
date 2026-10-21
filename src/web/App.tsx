import * as React from "react";
import { ArrowLeftRight, Layers, LayoutGrid, Lock, Menu as MenuIcon, Monitor, Moon, Plug, Search, Sun, X } from "lucide-react";
import type { HandoffListItem } from "../types";
import { agentName } from "@/lib/agents";
import { DataProvider, useData } from "@/lib/data";
import { timeAgo } from "@/lib/format";
import { href, useRoute, type Route } from "@/lib/router";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { AgentLogo, AgentStack } from "@/components/agent-logo";
import { CommandMenu } from "@/components/command-menu";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd, Spinner } from "@/components/ui/misc";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { ConnectView } from "@/views/connect";
import { HandoffDetailView } from "@/views/handoff-detail";
import { HandoffsView } from "@/views/handoffs";
import { OverviewView } from "@/views/overview";
import { PacksView } from "@/views/packs";

export function App() {
  return (
    <ToastProvider>
      <DataWithToasts />
    </ToastProvider>
  );
}

function DataWithToasts() {
  const notify = useToast();
  const onNewHandoff = React.useCallback(
    (handoff: HandoffListItem) =>
      notify(
        <a href={href(`/handoffs/${handoff.id}`)} className="pointer-events-auto flex items-center gap-2">
          <AgentLogo source={handoff.source} size={16} />
          New handoff from {agentName(handoff.source)}: <span className="font-medium">{handoff.task}</span>
        </a>
      ),
    [notify]
  );
  return (
    <DataProvider onNewHandoff={onNewHandoff}>
      <Shell />
    </DataProvider>
  );
}

function Shell() {
  const data = useData();
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [navOpen, setNavOpen] = React.useState(false);
  const main = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const routeKey = route.path.join("/");
  React.useEffect(() => {
    setNavOpen(false);
    setSearchOpen(false);
    main.current?.scrollTo({ top: 0 });
  }, [routeKey]);

  if (data.state === "loading") {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  if (data.state === "error") {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="max-w-sm text-center">
          <Mark className="mx-auto size-8" />
          <h1 className="mt-4 text-[17px] font-semibold">Can’t reach ContextPool</h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">{data.error}</p>
          <p className="mt-1 text-[13px] text-faint">
            Check that <code className="font-mono">ctxpool ui</code> is still running in your terminal.
          </p>
          <Button variant="secondary" className="mt-5" onClick={() => void data.reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <MobileBar onMenu={() => setNavOpen(true)} onSearch={() => setSearchOpen(true)} />
      {navOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setNavOpen(false)} />}
      <Sidebar route={route} open={navOpen} theme={theme} onTheme={setTheme} onSearch={() => setSearchOpen(true)} onClose={() => setNavOpen(false)} />
      <main ref={main} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {data.error && (
          <div className="sticky top-0 z-20 border-b border-border bg-warn/10 px-4 py-1.5 text-center text-[12.5px] text-warn backdrop-blur">Lost connection to ContextPool. Retrying…</div>
        )}
        <View route={route} />
      </main>
      <CommandMenu open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function View({ route }: { route: Route }) {
  const [section, id] = route.path;
  if (section === "handoffs" && id) return <HandoffDetailView key={id} id={id} tab={route.query.get("tab") || "overview"} />;
  if (section === "handoffs") return <HandoffsView query={route.query} />;
  if (section === "packs") return <PacksView key={id || "list"} id={id} />;
  if (section === "connect") return <ConnectView />;
  return <OverviewView />;
}

function Sidebar({ route, open, theme, onTheme, onSearch, onClose }: { route: Route; open: boolean; theme: ThemePreference; onTheme: (theme: ThemePreference) => void; onSearch: () => void; onClose: () => void }) {
  const { status, handoffs, tasks, packs } = useData();
  const section = route.path[0] || "";
  const activeTask = section === "handoffs" ? route.query.get("task") : undefined;
  const agentsByTask = React.useMemo(() => {
    const map = new Map<string, HandoffListItem["source"][]>();
    for (const handoff of handoffs) map.set(handoff.task, [...(map.get(handoff.task) || []), handoff.source]);
    return map;
  }, [handoffs]);

  const nav = [
    { key: "", label: "Overview", icon: LayoutGrid, to: "/" },
    { key: "handoffs", label: "Handoffs", icon: ArrowLeftRight, to: "/handoffs", count: status?.handoffCount },
    { key: "packs", label: "Context packs", icon: Layers, to: "/packs", count: packs.length || undefined },
    { key: "connect", label: "Connect agents", icon: Plug, to: "/connect" }
  ];

  return (
    <nav
      aria-label="Main"
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex w-[260px] shrink-0 flex-col border-r border-border bg-subtle transition-transform duration-200 md:static md:z-auto md:w-[240px] md:translate-x-0",
        open ? "translate-x-0 shadow-2xl" : "-translate-x-full"
      )}
    >
      <div className="flex h-12 items-center gap-2 px-4">
        <a href="#/" className="flex items-center gap-2 rounded-md">
          <Mark className="size-[22px]" />
          <span className="text-[14px] font-semibold tracking-[-0.01em]">ContextPool</span>
        </a>
        {status && <span className="text-[11.5px] text-faint">v{status.version}</span>}
        <IconButton label="Close menu" size="icon-sm" className="ml-auto md:hidden" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div className="px-3">
        <button onClick={onSearch} className="flex h-8 w-full items-center gap-2 rounded-md border border-border-strong bg-background px-2.5 text-[13px] text-faint transition-colors hover:text-muted-foreground">
          <Search className="size-4" />
          <span className="flex-1 text-left">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-3">
        <ul className="space-y-px">
          {nav.map((item) => {
            const active = section === item.key && !(item.key === "handoffs" && activeTask);
            return (
              <li key={item.key}>
                <a
                  href={`#${item.to}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13.5px] transition-colors [&_svg]:size-4",
                    active ? "bg-hover font-medium text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"
                  )}
                >
                  <item.icon className={active ? "text-foreground" : "text-faint"} />
                  <span className="flex-1">{item.label}</span>
                  {item.count !== undefined && <span className="tabular text-[12px] text-faint">{item.count}</span>}
                </a>
              </li>
            );
          })}
        </ul>

        <div className="mb-1 mt-6 px-2 text-[12px] font-medium text-faint">Tasks</div>
        {tasks.length ? (
          <ul className="space-y-px">
            {tasks.slice(0, 15).map((task) => (
              <li key={task.task}>
                <a
                  href={href("/handoffs", { task: task.task })}
                  aria-current={activeTask === task.task ? "page" : undefined}
                  className={cn("group flex h-8 items-center gap-2 rounded-md px-2 text-[13px]", activeTask === task.task ? "bg-hover font-medium text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground")}
                >
                  <AgentStack sources={(agentsByTask.get(task.task) || []).slice(0, 3)} size={13} max={3} />
                  <span className="min-w-0 flex-1 truncate">{task.task}</span>
                  <span className="shrink-0 text-[11.5px] font-normal text-faint">{timeAgo(task.latestAt).replace(" ago", "")}</span>
                </a>
              </li>
            ))}
            {tasks.length > 15 && (
              <li>
                <a href="#/handoffs" className="flex h-7 items-center px-2 text-[12.5px] text-faint hover:text-muted-foreground">
                  All {tasks.length} tasks
                </a>
              </li>
            )}
          </ul>
        ) : (
          <p className="px-2 text-[12.5px] leading-5 text-faint">Tasks appear here after your first handoff.</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] text-faint" title={status?.home}>
          <Lock className="size-3.5" /> Stored on this machine
        </span>
        <ThemeToggle theme={theme} onTheme={onTheme} />
      </div>
    </nav>
  );
}

function ThemeToggle({ theme, onTheme }: { theme: ThemePreference; onTheme: (theme: ThemePreference) => void }) {
  const next: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
  const labels: Record<ThemePreference, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <IconButton label={`${labels[theme]}. Switch to ${next[theme]}.`} size="icon-sm" onClick={() => onTheme(next[theme])}>
      <Icon />
    </IconButton>
  );
}

function MobileBar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
      <IconButton label="Open menu" onClick={onMenu}>
        <MenuIcon />
      </IconButton>
      <a href="#/" className="flex items-center gap-2">
        <Mark className="size-5" />
        <span className="text-[14px] font-semibold">ContextPool</span>
      </a>
      <IconButton label="Search" className="ml-auto" onClick={onSearch}>
        <Search />
      </IconButton>
    </div>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <rect width="20" height="20" rx="5" className="fill-ink" />
      <path d="M6 7.5h4.2a2.8 2.8 0 0 1 0 5.6H6" fill="none" className="stroke-ink-foreground" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="14" cy="10.3" r="1.3" className="fill-ink-foreground" />
    </svg>
  );
}
