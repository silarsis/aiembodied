// Safety rules for tasks run by the aiembodied coding runner. Loaded by pi from its agent dir.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";

// The runner recognizes input dialogs from ask_echo by this title prefix.
const ASK_TITLE = "Question from pi: ";
const NO_ANSWER = "No answer was given; make a sensible choice and say so in your summary.";

const BLOCKED_BASH = ["git push", "gh pr", "gh api", "git remote", "git config --global"];
const SECRET_PATH = /(\.env|\.ssh|auth\.json|\.pi[\\/]+agent)/i;
const RISKY_BASH = /(rm\s+-\w*r\w*f|rm\s+-\w*f\w*r|del\s+\/s|Remove-Item\b[^\n]*-Recurse)/i;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

function protectedPrefixes(): string[] {
  return (process.env.CODER_PROTECTED_PATHS ?? "").split(";").map((s) => norm(s.trim())).filter(Boolean);
}

function isProtected(rel: string): boolean {
  return protectedPrefixes().some((pre) => {
    if (/[*?]/.test(pre)) {
      const re = new RegExp("^" + pre.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]") );
      return re.test(rel);
    }
    return rel.startsWith(pre);
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_echo",
    label: "Ask Echo",
    description:
      "Ask Echo, the assistant who gave you this task, a question you cannot answer from the code. " +
      "Use it instead of ending your turn with a question.",
    parameters: Type.Object({ question: Type.String({ description: "The question, short and specific." }) }),
    async execute(_toolCallId: string, params: { question: string }, _signal: unknown, _onUpdate: unknown, ctx: any) {
      let answer: string | undefined;
      try {
        answer = await ctx.ui.input(ASK_TITLE + params.question, "type the answer");
      } catch {
        answer = undefined;
      }
      const text = typeof answer === "string" && answer.trim() ? answer.trim() : NO_ANSWER;
      return { content: [{ type: "text", text }], details: { question: params.question, answered: text !== NO_ANSWER } };
    },
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const tool = String(event.toolName ?? "").toLowerCase();
    const input = event.input ?? event.args ?? {};
    const target = input.path ?? input.file_path ?? input.filePath;

    if (tool === "bash") {
      const cmd = String(input.command ?? "");
      const hit = BLOCKED_BASH.find((b) => cmd.toLowerCase().includes(b));
      if (hit) return { block: true, reason: `"${hit}" is not allowed; the runner handles git remotes and pull requests.` };
      if (RISKY_BASH.test(cmd)) {
        const ok = await ctx.ui.confirm("Recursive delete", `Allow this command?\n\n${cmd}`);
        if (!ok) return { block: true, reason: "Recursive delete was not approved." };
      }
      return;
    }

    const reads = tool === "read";
    const writes = tool === "write" || tool === "edit";
    if (!(reads || writes) || typeof target !== "string") return;

    if (SECRET_PATH.test(target)) return { block: true, reason: "This path holds secrets or agent config and is off limits." };
    if (writes) {
      const abs = path.resolve(process.cwd(), target);
      const rel = path.relative(process.cwd(), abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return { block: true, reason: "Writes outside the task directory are not allowed." };
      if (isProtected(norm(rel))) return { block: true, reason: `${norm(rel)} is protected; ask the user to change it.` };
    }
  });
}
