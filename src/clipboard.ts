import { spawnSync } from "node:child_process";

export function copyToClipboard(text: string): boolean {
  if (process.platform === "darwin") return pipe("pbcopy", [], text);
  if (process.platform === "win32") return pipe("clip", [], text);
  return (
    (process.env.WAYLAND_DISPLAY ? pipe("wl-copy", [], text) : false) ||
    pipe("xclip", ["-selection", "clipboard"], text) ||
    pipe("xsel", ["--clipboard", "--input"], text) ||
    pipe("clip.exe", [], text)
  );
}

function pipe(command: string, args: string[], input: string): boolean {
  const result = spawnSync(command, args, { input, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"], timeout: 3_000 });
  return !result.error && result.status === 0;
}
