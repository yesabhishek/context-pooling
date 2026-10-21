import * as React from "react";
import type { CommandRun, FileEdit, VerificationCommand } from "../../../types";
import { ChartTooltip, useWidth, type TooltipState } from "@/components/ui/tooltip";

const HEIGHT = 64;
const EDIT_Y = 16;
const RUN_Y = 44;

/**
 * The session's rhythm: file edits on top, shell commands below, in the order the agent ran them.
 * Checks that passed before the last edit are visibly to the left of the "last edit" rule.
 */
export function SessionStrip({ commands, edits, checks }: { commands: CommandRun[]; edits: FileEdit[]; checks: VerificationCommand[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tooltip, setTooltip] = React.useState<TooltipState>();
  const checkSet = React.useMemo(() => new Set(checks.map((check) => check.command)), [checks]);
  const seqs = [...commands.map((run) => run.seq), ...edits.map((edit) => edit.seq)];
  const min = Math.min(...seqs);
  const max = Math.max(...seqs);
  const left = 52;
  const right = 10;
  const x = (seq: number) => left + (max === min ? 0.5 : (seq - min) / (max - min)) * Math.max(1, width - left - right);
  const lastEdit = edits.length ? Math.max(...edits.map((edit) => edit.seq)) : undefined;

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setTooltip(undefined)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} className="block overflow-visible" role="img" aria-label={`${edits.length} edits and ${commands.length} commands in session order`}>
          <text x={0} y={EDIT_Y} dy="0.32em" className="fill-faint text-[11px]">
            Edits
          </text>
          <text x={0} y={RUN_Y} dy="0.32em" className="fill-faint text-[11px]">
            Runs
          </text>
          <line x1={left} x2={width - right} y1={EDIT_Y} y2={EDIT_Y} stroke="var(--grid)" />
          <line x1={left} x2={width - right} y1={RUN_Y} y2={RUN_Y} stroke="var(--grid)" />
          {lastEdit !== undefined && (
            <g>
              <line x1={x(lastEdit)} x2={x(lastEdit)} y1={4} y2={HEIGHT - 4} stroke="var(--axis)" />
            </g>
          )}
          {edits.map((edit, index) => (
            <rect
              key={`e${index}`}
              x={x(edit.seq) - 1}
              y={EDIT_Y - 6}
              width={2}
              height={12}
              rx={1}
              fill="var(--muted-foreground)"
              opacity={0.55}
              onPointerEnter={() => setTooltip({ x: x(edit.seq), y: EDIT_Y - 6, content: <EditTip edit={edit} /> })}
            />
          ))}
          {commands.map((run, index) => {
            const check = checkSet.has(run.command);
            const color = run.status === "passed" ? "var(--good)" : run.status === "failed" ? "var(--bad)" : "var(--faint)";
            return (
              <g key={`c${index}`} onPointerEnter={() => setTooltip({ x: x(run.seq), y: RUN_Y - 6, content: <RunTip run={run} check={check} /> })}>
                <circle cx={x(run.seq)} cy={RUN_Y} r={12} fill="transparent" />
                <circle cx={x(run.seq)} cy={RUN_Y} r={check ? 5 : 3.5} fill={run.status === "unknown" ? "var(--background)" : color} stroke={run.status === "unknown" ? color : "var(--background)"} strokeWidth={run.status === "unknown" ? 1.5 : 2} />
              </g>
            );
          })}
        </svg>
      )}
      <ChartTooltip state={tooltip} />
    </div>
  );
}

function EditTip({ edit }: { edit: FileEdit }) {
  return (
    <div className="max-w-[300px]">
      <div className="text-[11.5px] text-muted-foreground">Edited</div>
      <div className="truncate font-mono text-[12px]">{edit.path}</div>
    </div>
  );
}

function RunTip({ run, check }: { run: CommandRun; check: boolean }) {
  return (
    <div className="max-w-[320px]">
      <div className="text-[11.5px] text-muted-foreground">
        {check ? "Check" : "Command"} · {run.status === "unknown" ? "no exit code" : `${run.status}${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}`}
      </div>
      <div className="line-clamp-2 break-all font-mono text-[12px]">{run.command}</div>
      {run.errorLine && <div className="mt-1 line-clamp-2 text-[12px] text-bad">{run.errorLine}</div>}
    </div>
  );
}
