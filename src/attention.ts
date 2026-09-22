import { getPreferenceValues, LaunchProps, LaunchType, showHUD, updateCommandMetadata } from "@vicinae/api";
import { collectAgents, describeHerdrError, resolveHerdrBin } from "./lib/herdr";

interface Preferences {
  herdrPath?: string;
}

export default async function Command(props: LaunchProps) {
  const preferences = getPreferenceValues<Preferences>();
  const bin = resolveHerdrBin(preferences.herdrPath);
  const background = props.launchType === LaunchType.Background;

  try {
    const { entries, unreachableMachines } = await collectAgents(bin);
    const blocked = entries.filter((a) => a.agent_status === "blocked").length;
    const done = entries.filter((a) => a.agent_status === "done").length;
    const working = entries.filter((a) => a.agent_status === "working").length;

    let subtitle =
      entries.length === 0
        ? "No agents"
        : blocked > 0 || done > 0
          ? `🔔 ${blocked} blocked · ✅ ${done} done · ${working} working`
          : `💤 ${entries.length} agents, nothing needs you`;
    if (unreachableMachines.length > 0) subtitle += ` · ⚠ ${unreachableMachines.length} unreachable`;
    await updateCommandMetadata({ subtitle });

    if (!background) await showHUD(subtitle);
  } catch (caught) {
    await updateCommandMetadata({ subtitle: "herdr unreachable" });
    if (!background) await showHUD(`herdr unreachable: ${describeHerdrError(caught, bin)}`);
  }
}
