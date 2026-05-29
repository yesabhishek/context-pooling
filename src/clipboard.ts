import { spawnSync } from "node:child_process";

export function copyToClipboard(text: string): boolean {
  const platform = process.platform;
  if (platform === "darwin") return pipe("pbcopy", [], text);
  if (platform === "win32") return pipe("clip", [], text);
  return pipe("wl-copy", [], text) || pipe("xclip", ["-selection", "clipboard"], text) || pipe("xsel", ["--clipboard", "--input"], text);
}

function pipe(command: string, args: string[], input: string): boolean {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"]
  });
  return result.status === 0;
}
