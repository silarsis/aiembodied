/**
 * The part of the model's instructions that says how to move the avatar: animation and pose tags,
 * free-text {move:} tags when live motion is available, and the scene tags when a 3D room is active.
 */
export const ANIMATION_INSTRUCTION_PREFIX = 'Available animations:';

export function buildAnimationInstructions(
  availableAnimations: string[],
  availablePoses: string[],
  liveMotionAvailable = false,
  sceneInstructions = '',
): string {
  const animList = availableAnimations.length > 0 ? availableAnimations.join(', ') : 'none';
  const poseList = availablePoses.length > 0 ? availablePoses.join(', ') : 'none';
  const moveInstructions = liveMotionAvailable
    ? [
        'For any other body movement, include `{move:<short description of the movement>}`',
        '(e.g. `{move:shrugs with both shoulders}`); it is generated on the fly and starts within about a second.',
      ]
    : [];
  return [
    `${ANIMATION_INSTRUCTION_PREFIX} ${animList}.`,
    `Available poses: ${poseList}.`,
    'You have a 3D body you can control through animations or poses.',
    'To trigger an animation, include `{anim:<slug>}` in your response (e.g. `{anim:happy-wave}`).',
    'To apply a pose, include `{pose:<slug>}` in your response (e.g. `{pose:power-stance}`).',
    ...(availablePoses.includes('relaxed-neutral') ? [
      'Your base stances are relaxed-neutral, happiness, sadness, anger, fear, disgust, and surprise. Choose an available pose when it suits your emotion or the user asks for it. Use {pose:relaxed-neutral} to return to your relaxed stance.',
    ] : []),
    ...moveInstructions,
    'Multiple tags are allowed. Slug format: lowercase letters, numbers, and hyphens.',
    ...(sceneInstructions ? [sceneInstructions] : []),
  ].join(' ');
}
