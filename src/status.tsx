import { useCallback, useEffect, useState } from "react";
import {
  Action,
  ActionPanel,
  Clipboard,
  getPreferenceValues,
  Icon,
  List,
  showHUD,
  showToast,
  Toast,
} from "@vicinae/api";
import {
  AgentEntry,
  agentLabel,
  agentTarget,
  focusAgent,
  listAgents,
  listMachines,
  readAgent,
  resolveHerdrBin,
  shortAgent,
  shortenHome,
  statusRank,
  type AgentStatus,
} from "./lib/herdr";
import { formatCost, formatCostExact, formatTokens, getSessionCost, headlineTokens, type SessionCost } from "./lib/cost";

interface Preferences {
  herdrPath?: string;
  refreshInterval?: string;
}

const SECTIONS: Array<{ status: AgentStatus; title: string; icon: Icon }> = [
  { status: "blocked", title: "Needs input", icon: Icon.Exclamationmark },
  { status: "done", title: "Finished", icon: Icon.CheckCircle },
  { status: "working", title: "Working", icon: Icon.Clock },
  { status: "idle", title: "Idle", icon: Icon.Circle },
  { status: "unknown", title: "Unknown", icon: Icon.QuestionMarkCircle },
];

function statusIcon(status: AgentStatus): Icon {
  return SECTIONS.find((s) => s.status === status)?.icon ?? Icon.Circle;
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const bin = resolveHerdrBin(preferences.herdrPath);
  const intervalSec = Math.max(2, Number.parseInt(preferences.refreshInterval ?? "5", 10) || 5);

  const [entries, setEntries] = useState<AgentEntry[]>([]);
  const [costs, setCosts] = useState<Map<string, SessionCost>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [updatedAt, setUpdatedAt] = useState<Date | undefined>();

  const refreshCosts = useCallback(async (current: AgentEntry[]) => {
    const settled = await Promise.all(
      current.map(async (entry) => ({
        key: entry.key,
        cost: await getSessionCost(entry.agent_session?.agent, entry.agent_session?.value).catch(
          () => null,
        ),
      })),
    );
    setCosts((prev) => {
      const next = new Map(prev);
      for (const { key, cost } of settled) {
        if (cost) next.set(key, cost);
        else next.delete(key);
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const machines = await listMachines(bin).catch(() => []);
      const results = await Promise.allSettled([
        listAgents(bin, null),
        ...machines.map((m) => listAgents(bin, m.label)),
      ]);
      const merged: AgentEntry[] = [];
      const sources: Array<string | null> = [null, ...machines.map((m) => m.label)];
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const machine = sources[index] ?? null;
        for (const agent of result.value) {
          merged.push({
            ...agent,
            machine,
            key: `${machine ?? "local"}:${agent.pane_id}:${agent.name ?? ""}`,
          });
        }
      });
      merged.sort((a, b) => statusRank(a.agent_status) - statusRank(b.agent_status));
      setEntries(merged);
      setUpdatedAt(new Date());
      void refreshCosts(merged);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoading(false);
    }
  }, [bin, refreshCosts]);

  useEffect(() => {
    setIsLoading(true);
    void load();
    const id = setInterval(() => void load(), intervalSec * 1000);
    return () => clearInterval(id);
  }, [load, intervalSec]);

  const blocked = entries.filter((e) => e.agent_status === "blocked").length;
  const done = entries.filter((e) => e.agent_status === "done").length;

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter herdr agents..."
      navigationTitle={
        updatedAt
          ? `Herdr · ${blocked} blocked · ${done} done · updated ${updatedAt.toLocaleTimeString()}`
          : "Herdr agents"
      }
    >
      {error && (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not reach herdr"
          description={`${error}. Is the herdr server running? Start it with \`herdr\` in a terminal.`}
          actions={
            <ActionPanel>
              <Action title="Retry" icon={Icon.RotateAntiClockwise} onAction={() => void load()} />
            </ActionPanel>
          }
        />
      )}
      {!error &&
        entries.length === 0 &&
        !isLoading && (
          <List.EmptyView
            icon={Icon.CheckCircle}
            title="No agents running"
            description="Start one with `herdr agent start <name> --kind <kind> --pane <id>`, or run agents inside herdr panes."
            actions={
              <ActionPanel>
                <Action title="Refresh" icon={Icon.RotateAntiClockwise} onAction={() => void load()} />
              </ActionPanel>
            }
          />
        )}
      {SECTIONS.map((section) => {
        const items = entries.filter((e) => e.agent_status === section.status);
        if (items.length === 0) return null;
        return (
          <List.Section key={section.status} title={`${section.title} (${items.length})`}>
            {items.map((entry) => (
              <AgentRow
                key={entry.key}
                entry={entry}
                bin={bin}
                cost={costs.get(entry.key)}
                onDone={() => void load()}
              />
            ))}
          </List.Section>
        );
      })}
    </List>
  );
}

function AgentRow({
  entry,
  bin,
  cost,
  onDone,
}: {
  entry: AgentEntry;
  bin: string;
  cost?: SessionCost;
  onDone: () => void;
}) {
  const target = agentTarget(entry);
  const where = shortenHome(entry.foreground_cwd ?? entry.cwd);
  const base = entry.title ?? where;
  const sessionName = cost?.title && cost.title !== base ? cost.title : undefined;
  const subtitle = [entry.machine ? `🖥 ${entry.machine}` : null, base || null, sessionName]
    .filter(Boolean)
    .join(" · ");
  const ctxTokens = cost ? (cost.contextTokens ?? headlineTokens(cost)) : undefined;
  const costText =
    cost && ctxTokens !== undefined
      ? `${formatCost(cost)} · ${formatTokens(ctxTokens)} tok`
      : undefined;

  return (
    <List.Item
      title={agentLabel(entry)}
      subtitle={subtitle || undefined}
      icon={statusIcon(entry.agent_status)}
      accessories={[
        ...(costText ? [{ text: costText }] : []),
        { text: shortAgent(entry.agent) },
        { text: entry.pane_id },
      ]}
      detail={
        <List.Item.Detail
          markdown={`## ${agentLabel(entry)}\n\n- **Status:** ${entry.agent_status}\n- **Machine:** ${entry.machine ?? "local"}\n- **Pane:** ${entry.pane_id}\n- **Tab:** ${entry.tab_id}\n- **Cwd:** ${where || "—"}\n${sessionName ? `- **Session:** ${sessionName}\n` : ""}${cost?.contextTokens !== undefined ? `- **Context (current):** ${formatTokens(cost.contextTokens)} tok — same as the \`oc\` footer\n` : ""}${cost ? `- **Session total:** ${formatCostExact(cost)} (${formatTokens(cost.inputTokens)} in / ${formatTokens(cost.outputTokens)} out${cost.reasoningTokens ? ` / ${formatTokens(cost.reasoningTokens)} reasoning` : ""}${cost.cacheReadTokens || cost.cacheWriteTokens ? ` / cache ${formatTokens(cost.cacheReadTokens)}R ${formatTokens(cost.cacheWriteTokens)}W` : ""}, via ${cost.source})\n` : ""}`}
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title="Status" text={entry.agent_status} />
              <List.Item.Detail.Metadata.Label title="Machine" text={entry.machine ?? "local"} />
              <List.Item.Detail.Metadata.Label title="Target" text={target} />
              {entry.agent && <List.Item.Detail.Metadata.Label title="Agent" text={entry.agent} />}
              {sessionName && (
                <List.Item.Detail.Metadata.Label title="Session" text={sessionName} />
              )}
              {where && <List.Item.Detail.Metadata.Label title="Cwd" text={where} />}
              {cost?.contextTokens !== undefined && (
                <List.Item.Detail.Metadata.Label
                  title="Context"
                  text={`${formatTokens(cost.contextTokens)} tok`}
                />
              )}
              {cost && (
                <List.Item.Detail.Metadata.Label title="Session cost" text={formatCostExact(cost)} />
              )}
              {cost && (
                <List.Item.Detail.Metadata.Label
                  title="Tokens"
                  text={`${formatTokens(cost.inputTokens)} in / ${formatTokens(cost.outputTokens)} out${cost.reasoningTokens ? ` / ${formatTokens(cost.reasoningTokens)} reasoning` : ""}${cost.cacheReadTokens || cost.cacheWriteTokens ? ` / cache ${formatTokens(cost.cacheReadTokens)}R ${formatTokens(cost.cacheWriteTokens)}W` : ""}`}
                />
              )}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          <Action
            title="Focus Agent"
            icon={Icon.Eye}
            onAction={async () => {
              const toast = await showToast({ style: Toast.Style.Animated, title: "Focusing…" });
              try {
                await focusAgent(bin, target, entry.machine);
                toast.style = Toast.Style.Success;
                toast.title = "Focused (marked seen)";
                onDone();
              } catch (caught) {
                toast.style = Toast.Style.Failure;
                toast.title = "Focus failed";
                toast.message = caught instanceof Error ? caught.message : String(caught);
              }
            }}
          />
          <Action
            title="Copy Last Output"
            icon={Icon.CopyClipboard}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
            onAction={async () => {
              const toast = await showToast({ style: Toast.Style.Animated, title: "Reading…" });
              try {
                const output = await readAgent(bin, target, entry.machine, 80);
                await Clipboard.copy(output.slice(-4000));
                toast.style = Toast.Style.Success;
                toast.title = "Copied last output";
                await showHUD("Copied agent output");
              } catch (caught) {
                toast.style = Toast.Style.Failure;
                toast.title = "Read failed";
                toast.message = caught instanceof Error ? caught.message : String(caught);
              }
            }}
          />
          <Action
            title="Copy Pane ID"
            icon={Icon.Hashtag}
            onAction={() => Clipboard.copy(entry.pane_id)}
          />
          <ActionPanel.Section>
            <Action
              title="Refresh"
              icon={Icon.RotateAntiClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={onDone}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
