import { useEffect, useRef, useState } from 'react';
import { lerp, shouldDisableHeavyMotion } from '../utils/motion';

type Props = {
  motionEnabled: boolean;
};

/**
 * Custom anti-gravity cursor (dot + smooth eased ring) and global cursor-parallax
 * CSS variable updater (--cursor-x, --cursor-y).
 * Uses a single requestAnimationFrame loop and automatically disables on touch devices
 * or when prefers-reduced-motion is active.
 */
export default function InteractiveCursor({ motionEnabled }: Props) {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!motionEnabled || shouldDisableHeavyMotion()) {
      setActive(false);
      document.documentElement.style.setProperty('--cursor-x', '0');
      document.documentElement.style.setProperty('--cursor-y', '0');
      return;
    }

    setActive(true);

    const state = {
      targetX: window.innerWidth / 2,
      targetY: window.innerHeight / 2,
      ringX: window.innerWidth / 2,
      ringY: window.innerHeight / 2,
      normX: 0,
      normY: 0,
      currentNormX: 0,
      currentNormY: 0,
      hoveringInteractive: false,
      hoveringCard: false,
      visible: false,
    };

    let rafId = 0;

    const onPointerMove = (e: MouseEvent) => {
      state.targetX = e.clientX;
      state.targetY = e.clientY;
      state.normX = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
      state.normY = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;

      if (!state.visible) {
        state.visible = true;
        state.ringX = e.clientX;
        state.ringY = e.clientY;
      }

      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0) translate(-50%, -50%)`;
      }

      const target = e.target as HTMLElement | null;
      if (target) {
        state.hoveringInteractive = Boolean(
          target.closest('button, a, input, textarea, select, [role="button"], .is-editable')
        );
        state.hoveringCard = Boolean(target.closest('.service-card, .site-hero'));
      }
    };

    const onPointerLeave = () => {
      state.visible = false;
      state.normX = 0;
      state.normY = 0;
    };

    const tick = () => {
      state.ringX = lerp(state.ringX, state.targetX, 0.15);
      state.ringY = lerp(state.ringY, state.targetY, 0.15);
      state.currentNormX = lerp(state.currentNormX, state.normX, 0.08);
      state.currentNormY = lerp(state.currentNormY, state.normY, 0.08);

      // Update normalized cursor coordinates for subtle background & hero parallax
      document.documentElement.style.setProperty('--cursor-x', state.currentNormX.toFixed(4));
      document.documentElement.style.setProperty('--cursor-y', state.currentNormY.toFixed(4));

      if (ringRef.current) {
        const scale = state.hoveringInteractive ? 1.45 : state.hoveringCard ? 1.2 : 1;
        ringRef.current.style.transform = `translate3d(${state.ringX.toFixed(2)}px, ${state.ringY.toFixed(2)}px, 0) translate(-50%, -50%) scale(${scale})`;
        ringRef.current.style.opacity = state.visible ? '1' : '0';
        ringRef.current.classList.toggle('is-interactive', state.hoveringInteractive);
      }

      if (dotRef.current) {
        dotRef.current.style.opacity = state.visible ? '1' : '0';
        dotRef.current.classList.toggle('is-interactive', state.hoveringInteractive);
      }

      rafId = window.requestAnimationFrame(tick);
    };

    window.addEventListener('mousemove', onPointerMove, { passive: true });
    document.addEventListener('mouseleave', onPointerLeave);
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('mousemove', onPointerMove);
      document.removeEventListener('mouseleave', onPointerLeave);
      window.cancelAnimationFrame(rafId);
    };
  }, [motionEnabled]);

  if (!active) return null;

  return (
    <div className="custom-cursor-layer" aria-hidden="true">
      <div ref={dotRef} className="cursor-dot" />
      <div ref={ringRef} className="cursor-ring" />
    </div>
  );
}
