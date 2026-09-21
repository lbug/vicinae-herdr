import { getPreferenceValues, LaunchProps, LaunchType, showHUD, updateCommandMetadata } from "@vicinae/api";
import { listAgents, listMachines, resolveHerdrBin } from "./lib/herdr";

interface Preferences {
  herdrPath?: string;
}

export default async function Command(props: LaunchProps) {
  const preferences = getPreferenceValues<Preferences>();
  const bin = resolveHerdrBin(preferences.herdrPath);

  try {
    const machines = await listMachines(bin).catch(() => []);
    const lists = await Promise.all([listAgents(bin, null), ...machines.map((m) => listAgents(bin, m.label))]);
    const all = lists.flat();
    const blocked = all.filter((a) => a.agent_status === "blocked").length;
    const done = all.filter((a) => a.agent_status === "done").length;
    const working = all.filter((a) => a.agent_status === "working").length;

    const subtitle =
      all.length === 0
        ? "No agents"
        : blocked > 0 || done > 0
          ? `🔔 ${blocked} blocked · ✅ ${done} done · ${working} working`
          : `💤 ${all.length} agents, nothing needs you`;
    await updateCommandMetadata({ subtitle });

    if (props.launchType === LaunchType.Background) return;
    await showHUD(subtitle);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await updateCommandMetadata({ subtitle: "herdr unreachable" });
    if (props.launchType !== LaunchType.Background) {
      await showHUD(`herdr unreachable: ${message}`);
    }
  }
}
