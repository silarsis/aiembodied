import { memo, useEffect, useMemo, useRef } from 'react';
import type { VisemeFrame } from '../audio/viseme-driver.js';

export interface AvatarRendererProps {
  frame: VisemeFrame | null;
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
}

const BLINK_DURATION_MS = 180;
const MIN_AUTO_BLINK_MS = 2800;
const MAX_AUTO_BLINK_MS = 4400;

export const AvatarRenderer = memo(function AvatarRenderer({ frame }: AvatarRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<VisemeFrame | null>(null);
  const idleStartRef = useRef<number>(now());
  const blinkStateRef = useRef({
    active: false,
    start: now(),
    duration: BLINK_DURATION_MS,
    nextAuto: now() + MIN_AUTO_BLINK_MS,
  });
  const randomRef = useRef<() => number>(() => Math.random());

  useEffect(() => {
    frameRef.current = frame;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    canvas.dataset.visemeIndex = String(frame?.index ?? 0);
    canvas.dataset.visemeIntensity = (frame?.intensity ?? 0).toFixed(3);
    canvas.dataset.blink = frame?.blink ? 'true' : 'false';

    if (frame?.blink) {
      blinkStateRef.current = {
        active: true,
        start: now(),
        duration: BLINK_DURATION_MS,
        nextAuto: now() + MIN_AUTO_BLINK_MS,
      };
    } else if (frame?.intensity && frame.intensity > 0.35) {
      blinkStateRef.current.nextAuto = Math.max(blinkStateRef.current.nextAuto, now() + 800);
    }
  }, [frame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const isJsdom =
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? /jsdom/i.test(navigator.userAgent)
        : false;
    if (isJsdom) {
      return;
    }

    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d');
    } catch (error) {
      console.warn('AvatarRenderer: unable to acquire 2D context', error);
      return;
    }

    if (!context) {
      return;
    }

    const scope = (typeof window !== 'undefined' ? window : globalThis) as typeof globalThis & {
      requestAnimationFrame?: typeof requestAnimationFrame;
      cancelAnimationFrame?: typeof cancelAnimationFrame;
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
      devicePixelRatio?: number;
    };

    const requestFrame: (callback: FrameRequestCallback) => number =
      typeof scope.requestAnimationFrame === 'function'
        ? scope.requestAnimationFrame.bind(scope)
        : ((callback: FrameRequestCallback) => scope.setTimeout(() => callback(now()), 16) as unknown as number);
    const cancelFrame: (handle: number) => void =
      typeof scope.cancelAnimationFrame === 'function'
        ? scope.cancelAnimationFrame.bind(scope)
        : ((handle: number) => {
            scope.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
          });

    let animationHandle: number | null = null;

    const render = (timestamp: number) => {
      const currentFrame = frameRef.current;
      const devicePixelRatio = scope.devicePixelRatio ?? 1;
      const rect = canvas.getBoundingClientRect();
      const width = rect.width || canvas.width || 320;
      const height = rect.height || canvas.height || 320;
      const targetWidth = Math.max(1, Math.round(width * devicePixelRatio));
      const targetHeight = Math.max(1, Math.round(height * devicePixelRatio));

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      context.save();
      context.scale(devicePixelRatio, devicePixelRatio);
      context.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const headRadius = Math.min(width, height) * 0.38;
      const elapsed = Number.isFinite(timestamp) ? timestamp : now();
      const idlePhase = (elapsed - idleStartRef.current) / 1000;
      const idleBob = Math.sin(idlePhase * Math.PI * 1.2) * (headRadius * 0.04);
      const idleSway = Math.sin(idlePhase * Math.PI * 0.6) * (headRadius * 0.02);

      const intensity = Math.min(1, Math.max(0, currentFrame?.intensity ?? 0));
      const visemeIndex = currentFrame?.index ?? 0;

      const blinkState = blinkStateRef.current;
      const nowTs = Number.isFinite(timestamp) ? timestamp : now();
      if (!blinkState.active && nowTs >= blinkState.nextAuto && intensity < 0.35) {
        const jitter = randomRef.current();
        blinkState.active = true;
        blinkState.start = nowTs;
        blinkState.duration = BLINK_DURATION_MS;
        blinkState.nextAuto = nowTs + MIN_AUTO_BLINK_MS + jitter * (MAX_AUTO_BLINK_MS - MIN_AUTO_BLINK_MS);
      }

      let blinkProgress = 0;
      if (blinkState.active) {
        const blinkElapsed = nowTs - blinkState.start;
        const halfDuration = blinkState.duration / 2;
        if (blinkElapsed >= blinkState.duration) {
          blinkState.active = false;
          blinkState.nextAuto = nowTs + MIN_AUTO_BLINK_MS + randomRef.current() * (MAX_AUTO_BLINK_MS - MIN_AUTO_BLINK_MS);
          blinkProgress = 0;
        } else if (blinkElapsed < halfDuration) {
          blinkProgress = Math.min(1, blinkElapsed / halfDuration);
        } else {
          blinkProgress = Math.max(0, 1 - (blinkElapsed - halfDuration) / halfDuration);
        }
      }

      // Background glow
      const gradient = context.createRadialGradient(centerX, centerY, headRadius * 0.1, centerX, centerY, headRadius * 1.4);
      gradient.addColorStop(0, '#fef3c7');
      gradient.addColorStop(1, '#fde68a00');
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      context.save();
      context.translate(centerX + idleSway, centerY + idleBob);

      // Neck
      context.beginPath();
      context.moveTo(-headRadius * 0.32, headRadius * 0.9);
      context.quadraticCurveTo(0, headRadius * 1.1, headRadius * 0.32, headRadius * 0.9);
      context.lineTo(headRadius * 0.22, headRadius * 1.5);
      context.quadraticCurveTo(0, headRadius * 1.6, -headRadius * 0.22, headRadius * 1.5);
      context.closePath();
      context.fillStyle = '#facc15';
      context.fill();

      // Head base
      context.beginPath();
      context.ellipse(0, 0, headRadius * 1.02, headRadius * 1.12, 0, 0, Math.PI * 2);
      context.fillStyle = '#fde68a';
      context.fill();

      // Face shadow
      context.beginPath();
      context.ellipse(0, headRadius * 0.2, headRadius * 0.96, headRadius * 0.9, 0, 0, Math.PI * 2);
      context.fillStyle = 'rgba(249, 115, 22, 0.06)';
      context.fill();

      // Eyes
      const eyeOffsetX = headRadius * 0.42;
      const eyeOffsetY = -headRadius * 0.15;
      const eyeWidth = headRadius * 0.22;
      const eyeHeightBase = headRadius * 0.18;
      const eyeHeight = Math.max(eyeHeightBase * (1 - blinkProgress * 0.92), headRadius * 0.02);
      for (const direction of [-1, 1]) {
        context.beginPath();
        context.ellipse(direction * eyeOffsetX, eyeOffsetY, eyeWidth, eyeHeight, 0, 0, Math.PI * 2);
        context.fillStyle = '#0f172a';
        context.fill();

        context.globalAlpha = 0.75;
        context.beginPath();
        context.ellipse(direction * eyeOffsetX + headRadius * 0.05, eyeOffsetY - eyeHeight * 0.25, eyeWidth * 0.4, eyeHeight * 0.4, 0, 0, Math.PI * 2);
        context.fillStyle = 'white';
        context.fill();
        context.globalAlpha = 1;
      }

      // Brows
      context.lineWidth = headRadius * 0.06;
      context.lineCap = 'round';
      context.strokeStyle = 'rgba(15, 23, 42, 0.65)';
      context.beginPath();
      context.moveTo(-eyeOffsetX - headRadius * 0.05, eyeOffsetY - eyeHeightBase * 0.9);
      context.quadraticCurveTo(-headRadius * 0.15, eyeOffsetY - eyeHeightBase * (1.2 + intensity * 0.2), eyeOffsetX + headRadius * 0.05, eyeOffsetY - eyeHeightBase * 0.9);
      context.stroke();

      // Cheek blush
      context.globalAlpha = 0.18 + intensity * 0.25;
      for (const direction of [-1, 1]) {
        context.beginPath();
        context.ellipse(direction * headRadius * 0.5, headRadius * 0.35, headRadius * 0.3, headRadius * 0.18, 0, 0, Math.PI * 2);
        context.fillStyle = '#f97316';
        context.fill();
      }
      context.globalAlpha = 1;

      // Mouth
      const mouthWidth = headRadius * (0.68 + intensity * 0.25);
      const mouthHeight = headRadius * (0.08 + intensity * 0.32);
      const mouthY = headRadius * 0.55;

      context.beginPath();
      context.moveTo(-mouthWidth / 2, mouthY);
      const upperLift = mouthHeight * (0.35 + visemeIndex * 0.08);
      context.quadraticCurveTo(0, mouthY - upperLift, mouthWidth / 2, mouthY);
      const lowerDepth = mouthHeight * (0.75 + intensity * 0.4 + visemeIndex * 0.05);
      context.quadraticCurveTo(0, mouthY + lowerDepth, -mouthWidth / 2, mouthY);
      context.closePath();
      context.fillStyle = '#fb7185';
      context.fill();
      context.lineWidth = headRadius * 0.02;
      context.strokeStyle = 'rgba(190, 18, 60, 0.8)';
      context.stroke();

      // Inner mouth shading
      context.save();
      context.beginPath();
      const innerWidth = mouthWidth * (0.55 + intensity * 0.3);
      const innerDepth = mouthHeight * (0.9 + intensity * 0.5);
      context.moveTo(-innerWidth / 2, mouthY);
      context.quadraticCurveTo(0, mouthY + innerDepth, innerWidth / 2, mouthY);
      context.quadraticCurveTo(0, mouthY + innerDepth * 1.1, -innerWidth / 2, mouthY);
      context.closePath();
      context.fillStyle = 'rgba(136, 19, 55, 0.85)';
      context.fill();
      context.restore();

      // Teeth for softer visemes
      if (visemeIndex <= 1 && intensity < 0.55) {
        context.save();
        context.globalAlpha = 0.8;
        context.beginPath();
        context.moveTo(-mouthWidth * 0.3, mouthY);
        context.quadraticCurveTo(0, mouthY - mouthHeight * 0.25, mouthWidth * 0.3, mouthY);
        context.quadraticCurveTo(0, mouthY - mouthHeight * 0.1, -mouthWidth * 0.3, mouthY);
        context.closePath();
        context.fillStyle = '#fefefe';
        context.fill();
        context.restore();
      }

      // Idle shimmer
      context.globalAlpha = 0.08;
      context.beginPath();
      context.ellipse(-headRadius * 0.35, -headRadius * 0.35, headRadius * 0.25, headRadius * 0.4, Math.PI / 6, 0, Math.PI * 2);
      context.fillStyle = 'white';
      context.fill();
      context.globalAlpha = 1;

      context.restore();
      context.restore();

      animationHandle = requestFrame(render);
    };

    animationHandle = requestFrame(render);

    return () => {
      if (animationHandle !== null) {
        cancelFrame(animationHandle);
      }
    };
  }, []);

  const ariaLabel = useMemo(() => {
    if (!frame) {
      return 'Assistant avatar idle';
    }

    const visemeIndex = frame.index;
    const intensity = Math.round(frame.intensity * 100);
    const blinkLabel = frame.blink ? ', blink triggered' : '';
    return `Assistant avatar speaking with viseme ${visemeIndex} at ${intensity}% intensity${blinkLabel}`;
  }, [frame]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel}
      className="avatar__canvas"
      data-viseme-index="0"
      data-viseme-intensity="0.000"
      data-blink="false"
    />
  );
});

