/**
 * The 54 sentences of scripts/floor-intent-check.mjs with their truth values. Keep this table and the
 * `cases` table in that script in step (same order, same wording).
 *
 * `speaker`, `intent` and `target` are the truth: one accepted string, or a list of accepted strings.
 * `scene` is in scene order (the first avatar hosts). `last` is who Kevin last spoke with. A debatable
 * case is replayed but not scored (47 of the 54 are scored).
 */
export interface IntentCase {
  grade: 'simple' | 'medium' | 'convoluted';
  text: string;
  speaker: string | string[];
  intent: string | string[];
  target: string | string[];
  scene: string[];
  last: string | null;
  recent: Array<[string, string]>;
  debatable: boolean;
}

export const INTENT_CASES: IntentCase[] = [
  { grade: 'simple', text: 'Sage, what time is it?', speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Hey Echo, how are you?', speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: "What's the weather like?", speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: 'Sage', recent: [], debatable: false },
  { grade: 'simple', text: "What's the weather like?", speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'You two, introduce yourselves.', speaker: 'everyone', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Echo, talk to Sage.', speaker: 'echo', intent: 'converse', target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Sage, ask Echo what time it is.', speaker: 'sage', intent: 'relay', target: 'echo', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Echo, tell me a joke.', speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Sage, how was your day?', speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Thanks, that was really helpful.', speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: 'Sage', recent: [], debatable: false },
  { grade: 'simple', text: 'Hello everybody.', speaker: 'everyone', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Sage, go and talk to Echo.', speaker: 'sage', intent: 'converse', target: 'echo', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Echo, ask Sage if she wants some tea.', speaker: 'echo', intent: 'relay', target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Both of you, say hello.', speaker: 'everyone', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: "Rex, what's your favourite colour?", speaker: 'rex', intent: 'answer', target: 'none', scene: ['Echo','Sage','Rex'], last: null, recent: [], debatable: false },
  { grade: 'simple', text: 'Hi Sage!', speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: false },
  { grade: 'medium', text: 'Can you strike up a conversation with Sage, please?', speaker: 'echo', intent: 'converse', target: 'sage', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: false },
  { grade: 'medium', text: 'Can you strike up a conversation with Echo, please?', speaker: 'sage', intent: 'converse', target: 'echo', scene: ['Echo','Sage'], last: 'Sage', recent: [], debatable: false },
  { grade: 'medium', text: "I'd like you to talk to Sage.", speaker: 'echo', intent: 'converse', target: 'sage', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: false },
  { grade: 'medium', text: 'Hey Echo, talk to Sage', speaker: 'echo', intent: 'converse', target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'medium', text: 'I want you to take your avatar and sit on the chair.', speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: false },
  { grade: 'medium', text: 'Echo, what do you think of Sage?', speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'medium', text: 'Tell me about Sage.', speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: false },
  { grade: 'medium', text: 'Sage, talk to me.', speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'medium', text: 'I want to talk to Sage.', speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: false },
  { grade: 'medium', text: 'Could one of you find out from Sage what she had planned today?', speaker: 'echo', intent: 'relay', target: 'sage', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: false },
  { grade: 'medium', text: "Why don't you two have a chat about the weekend.", speaker: 'echo', intent: 'converse', target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: true },
  { grade: 'medium', text: 'Everyone, what do you think?', speaker: 'everyone', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'medium', text: 'Sage, could you have a chat with Echo?', speaker: 'sage', intent: 'converse', target: 'echo', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'medium', text: "Echo, go and ask Sage what she's cooking.", speaker: 'echo', intent: 'relay', target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'medium', text: 'Tell Sage I said hello.', speaker: 'echo', intent: 'relay', target: 'sage', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: false },
  { grade: 'medium', text: 'What does Sage think about this?', speaker: 'echo', intent: ['answer','relay'], target: ['none','sage'], scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: true },
  { grade: 'medium', text: 'Rex, say something to Echo.', speaker: 'rex', intent: 'converse', target: 'echo', scene: ['Echo','Sage','Rex'], last: null, recent: [], debatable: false },
  { grade: 'medium', text: 'Let Rex and Sage talk for a while.', speaker: ['rex','sage'], intent: 'converse', target: ['rex','sage'], scene: ['Echo','Sage','Rex'], last: null, recent: [], debatable: true },
  { grade: 'convoluted', text: "Echo, I don't want to hear from Sage right now, just tell me the time.", speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'Not you, Echo. Sage, what do you think?', speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'Sage, when you get a second, see if Echo remembers where I left my keys and let me know.', speaker: 'sage', intent: 'relay', target: 'echo', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: "I was telling Sage earlier about my trip. Anyway Echo, what's on my calendar?", speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: "Echo, would you mind getting Sage's opinion on the sofa colour and then telling me what you both decide?", speaker: 'echo', intent: ['relay','converse'], target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'My friend Sage from work is coming over later.', speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: 'Echo', recent: [], debatable: true },
  { grade: 'convoluted', text: 'Rex, can you get those two to stop arguing?', speaker: 'rex', intent: ['answer','converse'], target: ['none','echo','sage'], scene: ['Echo','Sage','Rex'], last: null, recent: [], debatable: true },
  { grade: 'convoluted', text: 'Sage, tell Echo she should talk to Rex.', speaker: 'sage', intent: 'relay', target: 'echo', scene: ['Echo','Sage','Rex'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: "Could somebody who isn't Echo answer this one: what's two plus two?", speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'Go on then, the pair of you, argue it out.', speaker: ['echo','sage'], intent: 'converse', target: ['echo','sage'], scene: ['Echo','Sage'], last: null, recent: [], debatable: true },
  { grade: 'convoluted', text: 'Ask her yourself.', speaker: 'echo', intent: ['converse','relay'], target: 'sage', scene: ['Echo','Sage'], last: 'Echo', recent: [['Echo','I wonder what Sage thinks about that.']], debatable: false },
  { grade: 'convoluted', text: "I'd love to hear the two of you discuss whether cats are better than dogs. Sage, you start.", speaker: 'sage', intent: 'converse', target: 'echo', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'hey echo um can you like talk to sage for a bit', speaker: 'echo', intent: 'converse', target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'sage can you uh strike up a chat with echo', speaker: 'sage', intent: 'converse', target: 'echo', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'echo talk to sage', speaker: 'echo', intent: 'converse', target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'Hey Eko, have a word with Sage.', speaker: 'echo', intent: 'converse', target: 'sage', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'Echo, stop talking to Sage and talk to me.', speaker: 'echo', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: "Rex, forget Echo for a second, what's the capital of France?", speaker: 'rex', intent: 'answer', target: 'none', scene: ['Echo','Sage','Rex'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: "Sage, I'm not asking Echo, I'm asking you: will it rain?", speaker: 'sage', intent: 'answer', target: 'none', scene: ['Echo','Sage'], last: null, recent: [], debatable: false },
  { grade: 'convoluted', text: 'Tell her I said thanks.', speaker: 'sage', intent: 'relay', target: 'echo', scene: ['Echo','Sage'], last: 'Sage', recent: [['Sage','Echo found the recipe for you.']], debatable: true },
];
