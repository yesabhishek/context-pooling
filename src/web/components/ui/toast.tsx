import * as React from "react";
import { cn } from "@/lib/utils";

type Toast = { id: number; message: React.ReactNode };
const ToastContext = React.createContext<(message: React.ReactNode) => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const notify = React.useCallback((message: React.ReactNode) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 2600);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((toast) => (
          <div key={toast.id} className={cn("animate-pop-in flex items-center gap-2 rounded-lg bg-ink px-3 py-2 text-[13px] text-ink-foreground shadow-lg [&_svg]:size-4")}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return React.useContext(ToastContext);
}

/** Copy text and confirm with a toast. */
export function useCopy() {
  const notify = useToast();
  return React.useCallback(
    async (text: string, message = "Copied") => {
      if (await writeClipboard(text)) notify(message);
      else notify("Couldn’t copy. Your browser blocked clipboard access.");
    },
    [notify]
  );
}

/**
 * The Clipboard API only exists on secure origins, so `ctxpool ui --host 0.0.0.0` opened from another
 * device has none; fall back to a selected textarea there.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
