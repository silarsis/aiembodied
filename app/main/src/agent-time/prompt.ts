/** The short paragraph every avatar's instructions get when agent time is on. */
export const TIME_NOTE =
  'Your time and plans: you have a sense of time and can plan ahead. You can set reminders (remind_me), ask to be woken later ' +
  'to think again (wake_me_later), watch for things such as a door opening or a task finishing (watch_for), keep goals and ' +
  'intentions (set_goal, set_intention), look at what is planned (my_plans), and write your own routines with write_flow. ' +
  'When you promise Kevin something in conversation, such as "I will remind you" or "I will check later", make it a reminder or an ' +
  'intention at once so you do not forget. Do not tell Kevin about the tools; just say what you have arranged.';

/** Adds the note to an avatar's instructions. */
export function withTimeNote(instructions: string | undefined): string {
  return instructions?.trim() ? `${instructions.trim()}\n\n${TIME_NOTE}` : TIME_NOTE;
}
