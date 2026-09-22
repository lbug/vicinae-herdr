import { useCallback, useEffect, useRef, useState } from "react";
import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  getPreferenceValues,
  Icon,
  Image,
  List,
  showToast,
  Toast,
} from "@vicinae/api";
import {
  AgentEntry,
  agentDisplayName,
  agentIconAsset,
  agentTarget,
  agentTitle,
  collectAgents,
  describeHerdrError,
  focusAgent,
  readAgent,
  resolveHerdrBin,
  shortenHome,
  type AgentStatus,
} from "./lib/herdr";
import { cleanTerminalOutput, getLastResponse } from "./lib/transcript";
import { formatCost, formatCostExact, formatTokens, getSessionCost, headlineTokens, type SessionCost } from "./lib/cost";

interface Preferences {
  herdrPath?: string;
  refreshInterval?: string;
}

const SECTIONS: Array<{ status: AgentStatus; title: string; icon: Image.ImageLike }> = [
  { status: "blocked", title: "Needs input", icon: { source: Icon.Exclamationmark, tintColor: Color.Red } },
  { status: "done", title: "Finished", icon: { source: Icon.CheckCircle, tintColor: Color.Green } },
  { status: "working", title: "Working", icon: { source: Icon.Clock, tintColor: Color.Blue } },
  { status: "idle", title: "Idle", icon: { source: Icon.Circle, tintColor: Color.SecondaryText } },
  { status: "unknown", title: "Unknown", icon: { source: Icon.QuestionMarkCircle, tintColor: Color.SecondaryText } },
];

function statusIcon(status: AgentStatus): Image.ImageLike {
  return SECTIONS.find((s) => s.status === status)?.icon ?? Icon.Circle;
}

function statusTitle(status: AgentStatus): string {
  return SECTIONS.find((s) => s.status === status)?.title ?? status;
}

function agentIcon(agent: string | null): Image.ImageLike {
  const asset = agentIconAsset(agent);
  return asset ? { source: asset, tintColor: Color.PrimaryText } : Icon.Terminal;
}

type Preview = { key: string; markdown: string };

async function loadPreview(entry: AgentEntry, bin: string): Promise<string> {
  const response = entry.machine
    ? null
    : await getLastResponse(entry.agent_session?.agent, entry.agent_session?.value);
  if (response) return response;
  const terminal = cleanTerminalOutput(await readAgent(bin, agentTarget(entry), entry.machine, 60));
  const note = entry.machine ? "Remote agent" : `No readable transcript for ${entry.agent ?? "this agent"}`;
  // Use a fence longer than any backtick run in the output so it cannot break out of the block.
  const fence = "`".repeat(Math.max(3, ...(terminal.match(/`+/g) ?? []).map((run) => run.length + 1)));
  return `_${note} — showing terminal output._\n\n${fence}\n${terminal}\n${fence}`;
}

/**
 * Last response of the selected agent, loaded only while the detail panel is open.
 * Re-read on selection or status change, and on every poll while the agent is working.
 */
function usePreview(entry: AgentEntry | undefined, bin: string, enabled: boolean, tick: Date | undefined) {
  const [preview, setPreview] = useState<Preview | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const liveTick = entry?.agent_status === "working" ? tick : undefined;

  useEffect(() => {
    if (!enabled || !entry) return;
    let cancelled = false;
    setIsLoading(true);
    loadPreview(entry, bin)
      .catch((caught) => `_Could not read output: ${describeHerdrError(caught, bin)}_`)
      .then((markdown) => {
        if (cancelled) return;
        setPreview({ key: entry.key, markdown });
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, bin, entry?.key, entry?.agent_status, liveTick]);

  return { markdown: preview?.key === entry?.key ? preview?.markdown : undefined, isLoading };
}

function formatTokenBreakdown(cost: SessionCost): string {
  const parts = [`${formatTokens(cost.inputTokens)} in`, `${formatTokens(cost.outputTokens)} out`];
  if (cost.reasoningTokens) parts.push(`${formatTokens(cost.reasoningTokens)} reasoning`);
  if (cost.cacheReadTokens || cost.cacheWriteTokens) {
    parts.push(`cache ${formatTokens(cost.cacheReadTokens)}R ${formatTokens(cost.cacheWriteTokens)}W`);
  }
  return parts.join(" / ");
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const bin = resolveHerdrBin(preferences.herdrPath);
  const intervalSec = Math.max(2, Number.parseInt(preferences.refreshInterval ?? "5", 10) || 5);

  const [entries, setEntries] = useState<AgentEntry[]>([]);
  const [costs, setCosts] = useState<Map<string, SessionCost>>(new Map());
  const [unreachable, setUnreachable] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [updatedAt, setUpdatedAt] = useState<Date | undefined>();
  const [showDetail, setShowDetail] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const inFlight = useRef(false);

  const refreshCosts = useCallback(async (current: AgentEntry[]) => {
    const settled = await Promise.all(
      current.map(async (entry) => ({
        key: entry.key,
        // Session data of remote agents lives on the remote host; only local sessions have cost.
        cost: entry.machine
          ? null
          : await getSessionCost(entry.agent_session?.agent, entry.agent_session?.value).catch(() => null),
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
    // Remote machines can take a while; never stack polls on top of a slow one.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const snapshot = await collectAgents(bin);
      setEntries(snapshot.entries);
      setUnreachable(snapshot.unreachableMachines);
      setError(undefined);
      setUpdatedAt(new Date());
      void refreshCosts(snapshot.entries);
    } catch (caught) {
      setEntries([]);
      setError(describeHerdrError(caught, bin));
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }
  }, [bin, refreshCosts]);

  useEffect(() => {
    setIsLoading(true);
    void load();
    const id = setInterval(() => void load(), intervalSec * 1000);
    return () => clearInterval(id);
  }, [load, intervalSec]);

  const selected = entries.find((e) => e.key === selectedKey) ?? entries[0];
  const preview = usePreview(selected, bin, showDetail, updatedAt);

  const blocked = entries.filter((e) => e.agent_status === "blocked").length;
  const done = entries.filter((e) => e.agent_status === "done").length;
  const titleParts = ["Herdr", `${blocked} blocked`, `${done} done`];
  if (unreachable.length > 0) titleParts.push(`unreachable: ${unreachable.join(", ")}`);
  if (updatedAt) titleParts.push(`updated ${updatedAt.toLocaleTimeString()}`);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={showDetail && entries.length > 0}
      searchBarPlaceholder="Filter herdr agents..."
      onSelectionChange={setSelectedKey}
      navigationTitle={updatedAt ? titleParts.join(" · ") : "Herdr agents"}
    >
      {error && (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not reach herdr"
          description={`${error} Make sure the herdr server is running (start it with \`herdr\` in a terminal).`}
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
                showDetail={showDetail}
                preview={entry.key === selected?.key ? preview : undefined}
                onToggleDetail={() => setShowDetail((v) => !v)}
                onRefresh={() => void load()}
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
  showDetail,
  preview,
  onToggleDetail,
  onRefresh,
}: {
  entry: AgentEntry;
  bin: string;
  cost?: SessionCost;
  showDetail: boolean;
  preview?: { markdown?: string; isLoading: boolean };
  onToggleDetail: () => void;
  onRefresh: () => void;
}) {
  const target = agentTarget(entry);
  const agentName = agentDisplayName(entry.agent);
  const where = shortenHome(entry.foreground_cwd ?? entry.cwd);
  // The stored session title is complete; terminal titles are often truncated, so they only fill in.
  const sessionName = cost?.title || agentTitle(entry) || undefined;
  // Path first, then session; remote paths read like ssh targets ("host:~/src").
  const location = entry.machine ? `${entry.machine}:${where || "?"}` : where;
  // The agent logo identifies the agent, so the path leads — unless herdr has a custom name for it.
  const customName = entry.display_agent ?? entry.name;
  const title = customName ?? (location || agentName);
  const subtitle = [customName ? location : null, sessionName].filter(Boolean).join(" · ");
  const ctxTokens = cost ? (cost.contextTokens ?? headlineTokens(cost)) : undefined;
  const costText =
    cost && ctxTokens !== undefined ? `${formatCost(cost)} · ${formatTokens(ctxTokens)} tok` : undefined;

  return (
    <List.Item
      id={entry.key}
      title={title}
      subtitle={subtitle || undefined}
      icon={{ value: agentIcon(entry.agent), tooltip: agentName }}
      keywords={[entry.agent, agentName, entry.machine].filter((k): k is string => Boolean(k))}
      accessories={[
        ...(costText
          ? [{ text: costText, tooltip: cost?.contextTokens !== undefined ? "Session cost · current context" : "Session cost · tokens" }]
          : []),
        { text: entry.pane_id, tooltip: "Pane" },
        { icon: statusIcon(entry.agent_status), tooltip: statusTitle(entry.agent_status) },
      ]}
      detail={
        <List.Item.Detail
          isLoading={preview?.isLoading}
          markdown={preview?.markdown ?? ""}
          metadata={
            <List.Item.Detail.Metadata>
              {sessionName && <List.Item.Detail.Metadata.Label title="Session" text={sessionName} />}
              {cost?.contextTokens !== undefined && (
                <List.Item.Detail.Metadata.Label title="Context" text={`${formatTokens(cost.contextTokens)} tok`} />
              )}
              {cost && <List.Item.Detail.Metadata.Label title="Session cost" text={formatCostExact(cost)} />}
              <List.Item.Detail.Metadata.Label title="Status" text={entry.agent_status} />
              {where && <List.Item.Detail.Metadata.Label title="Cwd" text={where} />}
              {entry.machine && <List.Item.Detail.Metadata.Label title="Machine" text={entry.machine} />}
              <List.Item.Detail.Metadata.Separator />
              {cost && <List.Item.Detail.Metadata.Label title="Tokens" text={formatTokenBreakdown(cost)} />}
              <List.Item.Detail.Metadata.Label title="Agent" text={agentName} />
              <List.Item.Detail.Metadata.Label title="Target" text={target} />
              <List.Item.Detail.Metadata.Label title="Tab" text={entry.tab_id} />
              {cost && <List.Item.Detail.Metadata.Label title="Cost source" text={cost.source} />}
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
                onRefresh();
              } catch (caught) {
                toast.style = Toast.Style.Failure;
                toast.title = "Focus failed";
                toast.message = describeHerdrError(caught, bin);
              }
            }}
          />
          <Action
            title="Copy Last Response"
            icon={Icon.CopyClipboard}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            onAction={async () => {
              const toast = await showToast({ style: Toast.Style.Animated, title: "Reading…" });
              try {
                const response = entry.machine
                  ? null
                  : await getLastResponse(entry.agent_session?.agent, entry.agent_session?.value);
                if (response) {
                  await Clipboard.copy(response);
                  toast.style = Toast.Style.Success;
                  toast.title = "Copied last response";
                  return;
                }
                await Clipboard.copy(cleanTerminalOutput(await readAgent(bin, target, entry.machine, 200)));
                toast.style = Toast.Style.Success;
                toast.title = "Copied terminal output";
                toast.message = entry.machine
                  ? "Transcripts of remote agents are not readable"
                  : `No readable transcript for ${entry.agent ?? "this agent"}`;
              } catch (caught) {
                toast.style = Toast.Style.Failure;
                toast.title = "Read failed";
                toast.message = describeHerdrError(caught, bin);
              }
            }}
          />
          <Action
            title="Copy Terminal Output"
            icon={Icon.Terminal}
            shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
            onAction={async () => {
              const toast = await showToast({ style: Toast.Style.Animated, title: "Reading…" });
              try {
                await Clipboard.copy(cleanTerminalOutput(await readAgent(bin, target, entry.machine, 200)));
                toast.style = Toast.Style.Success;
                toast.title = "Copied terminal output";
              } catch (caught) {
                toast.style = Toast.Style.Failure;
                toast.title = "Read failed";
                toast.message = describeHerdrError(caught, bin);
              }
            }}
          />
          <Action.CopyToClipboard title="Copy Pane ID" content={entry.pane_id} />
          <ActionPanel.Section>
            <Action
              title={showDetail ? "Hide Details" : "Show Details"}
              icon={Icon.AppWindowSidebarLeft}
              shortcut={{ modifiers: ["cmd"], key: "d" }}
              onAction={onToggleDetail}
            />
            <Action
              title="Refresh"
              icon={Icon.RotateAntiClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={onRefresh}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
