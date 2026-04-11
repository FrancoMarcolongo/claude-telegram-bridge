import { InlineKeyboard } from "grammy";
import type { BridgeConfig } from "../types.js";

export function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("New Session", "action:new")
    .text("Sessions", "action:sessions")
    .row()
    .text("Status", "action:status")
    .text("Projects", "action:projects")
    .row()
    .text("Cost", "action:cost")
    .text("Help", "action:help");
}

export function afterResponseKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("New Session", "action:new")
    .text("Kill", "action:kill");
}

export function projectKeyboard(config: BridgeConfig): InlineKeyboard {
  const kb = new InlineKeyboard();
  const projects = Object.keys(config.projects);

  for (let i = 0; i < projects.length; i++) {
    kb.text(projects[i], `project:${projects[i]}`);
    if (i % 2 === 1) kb.row(); // 2 per row
  }

  if (projects.length % 2 === 1) kb.row();
  kb.text("Cancel", "action:dismiss");

  return kb;
}

export function modelKeyboard(currentModel: string): InlineKeyboard {
  const models = ["haiku", "sonnet", "opus"];
  const kb = new InlineKeyboard();

  for (const m of models) {
    const label = m === currentModel ? `${m} *` : m;
    kb.text(label, `model:${m}`);
  }

  return kb;
}

export function effortKeyboard(currentEffort: string): InlineKeyboard {
  const levels = ["low", "medium", "high", "max"];
  const kb = new InlineKeyboard();

  for (const l of levels) {
    const label = l === currentEffort ? `${l} *` : l;
    kb.text(label, `effort:${l}`);
  }

  return kb;
}

export function sessionListKeyboard(sessions: { id: string; name: string; active: boolean }[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const s of sessions.slice(0, 8)) { // Max 8 to avoid huge keyboards
    const label = s.active ? `${s.name} *` : s.name;
    kb.text(label, `session:${s.id.slice(0, 8)}`).row();
  }

  return kb;
}
