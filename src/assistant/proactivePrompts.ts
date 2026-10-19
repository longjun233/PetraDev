/**
 * 主动问候的 prompt 组装（纯函数，可直接单测）。
 *
 * 这是一条"临时 history、不进主对话历史"的轻量调用，要求
 * 「原文 + --- + 中文翻译」的格式，因此接入同一套语言指令。
 *
 * **这里的位置是硬性要求**：语言提醒必须排在所有中文要求的**最后一行**。
 *
 * 以前的写法是把语言指令放在 prompt 中段，后面还跟着"要求：简短（1-2句）、
 * 口语化、不要像客服"这类中文 —— 模型顺着最近的中文继续写，于是定时问候偶尔
 * 整句说中文、第一行写成中文、`---` 也丢了。
 *
 * 单纯把指令挪到最后还不够稳，所以这里是双保险：
 *   · 用户消息末尾 → buildLanguageReminder（模型对末尾最敏感）
 *   · system 侧     → proactiveLangInstruction（走 chatStream 的 extraContext）
 */

import { buildLanguageInstruction, buildLanguageReminder } from "../utils/outputLanguage";

export interface GreetingPromptParts {
  /** 例如 "2026/10/7 09:32:42" */
  timeStr: string;
  /** 例如 "星期三" */
  dayOfWeek: string;
  /** 例如 "正在使用：VS Code；窗口标题：…"，可为空 */
  ctx: string;
  /** 已格式化的记忆块（含前导换行），可为空 */
  memoryBlock: string;
  /** 心情低谷时的安慰模式说明（含前导换行），可为空 */
  comfortLine: string;
  outputLanguage: string;
}

/**
 * 主动问候的用户消息。
 * 语言提醒固定收尾，**不要**在它后面再拼任何中文要求。
 */
export function buildGreetingPrompt(p: GreetingPromptParts): string {
  const head =
    `[主动问候] ${p.timeStr}（${p.dayOfWeek}）${p.ctx ? "，" + p.ctx : ""}` +
    `${p.memoryBlock}${p.comfortLine}`;
  const body =
    "自然地和用户打个招呼或说一句关心的话，保持你的人设风格。\n" +
    "\n要求：简短（1-2句）、口语化、不要像客服。" +
    "不要说\"作为AI\"之类的话。";
  return `${head}\n\n${body}${trailingReminder(p.outputLanguage)}`;
}

/**
 * system 侧的语言指令（作为 chatStream 的 extraContext 传入）。
 * 和末尾提醒一起构成双保险：system 里定性，末尾提醒压制最近的中文语境。
 */
export function proactiveLangInstruction(outputLanguage: string): string {
  return buildLanguageInstruction(outputLanguage, { withTranslation: true });
}

/** 收尾提醒：非中文时前面补一个换行，中文/自动时返回空串（不改变原有排版） */
function trailingReminder(outputLanguage: string): string {
  const reminder = buildLanguageReminder(outputLanguage, { withTranslation: true });
  return reminder ? `\n${reminder}` : "";
}
