import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EASY_INPUTS = [
  "DETAILS - looks (blue eyes...)",
  "AVOID - dont want",
  "ACTION - what they are doing",
  "POSE - body position",
  "OUTFIT - clothes",
  "SCENE - place / lighting",
  "MODE",
  "SWEEP_SEED",
  "BALANCE - LEFT=face  RIGHT=prompt",
  "framing",
  "emphasize_action",
  "hands_in_frame",
  "frontal_face",
  "photoreal",
  "PRESET",
];

function widgetMap(node) {
  return new Map((node.widgets || []).map((widget) => [widget.name, widget]));
}

function collectFields(node) {
  const widgets = widgetMap(node);
  const fields = {};
  for (const name of EASY_INPUTS) {
    const widget = widgets.get(name);
    if (!widget) throw new Error(`Easy Prompt widget missing: ${name}`);
    fields[name] = widget.value;
  }
  return fields;
}

function decodePayload(payloadBase64) {
  const bytes = Uint8Array.from(atob(payloadBase64), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function applyFields(node, fields) {
  const widgets = widgetMap(node);
  for (const name of EASY_INPUTS) {
    if (!(name in fields)) continue;
    const widget = widgets.get(name);
    if (!widget) continue;
    widget.value = fields[name];
    try {
      widget.callback?.(widget.value, app.canvas, node);
    } catch {
      // Direct value assignment is sufficient for serialization; callbacks are best-effort.
    }
  }
  node.setDirtyCanvas(true, true);
}

async function listPresets() {
  const response = await api.fetchApi("/butler/easy-presets");
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.message || "Could not list presets.");
  return Array.isArray(data.presets) ? data.presets : [];
}

function choosePreset(presets, verb) {
  if (!presets.length) {
    window.alert("No Butler Easy Prompt presets have been saved yet.");
    return null;
  }
  const menu = presets.map((preset, index) => `${index + 1}. ${preset.name}`).join("\n");
  const answer = window.prompt(`${verb} which Base64 prompt preset?\n\n${menu}\n\nEnter number or exact name:`);
  if (!answer) return null;
  const index = Number.parseInt(answer, 10);
  if (Number.isFinite(index) && index >= 1 && index <= presets.length) return presets[index - 1];
  return presets.find((preset) => String(preset.name).toLowerCase() === answer.trim().toLowerCase()) || null;
}

app.registerExtension({
  name: "Butler.EasyPrompt.Base64Presets",

  nodeCreated(node) {
    if (node.comfyClass !== "ButlerEasyPrompt") return;

    node.addWidget("button", "💾 Save Base64 prompt preset", null, async () => {
      try {
        const name = window.prompt("Preset name (saves every Easy Prompt input):");
        if (!name?.trim()) return;
        const response = await api.fetchApi("/butler/easy-presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), fields: collectFields(node) }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message || "Could not save preset.");
        window.alert(data.message || `Saved "${name.trim()}" as Base64.`);
      } catch (error) {
        window.alert(`Butler preset save failed: ${error?.message || error}`);
      }
    });

    node.addWidget("button", "📂 Load Base64 prompt preset", null, async () => {
      try {
        const preset = choosePreset(await listPresets(), "Load");
        if (!preset) return;
        applyFields(node, decodePayload(preset.payload_base64));
        window.alert(`Loaded "${preset.name}" into every Easy Prompt input.`);
      } catch (error) {
        window.alert(`Butler preset load failed: ${error?.message || error}`);
      }
    });

    node.addWidget("button", "🗑 Delete Base64 prompt preset", null, async () => {
      try {
        const preset = choosePreset(await listPresets(), "Delete");
        if (!preset || !window.confirm(`Delete prompt preset "${preset.name}"?`)) return;
        const response = await api.fetchApi(`/butler/easy-presets/${encodeURIComponent(preset.id)}`, {
          method: "DELETE",
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message || "Could not delete preset.");
        window.alert(data.message || `Deleted "${preset.name}".`);
      } catch (error) {
        window.alert(`Butler preset delete failed: ${error?.message || error}`);
      }
    });

    const computed = node.computeSize();
    node.setSize([Math.max(node.size?.[0] || 0, 620), Math.max(node.size?.[1] || 0, computed[1])]);
    node.setDirtyCanvas(true, true);
  },
});
