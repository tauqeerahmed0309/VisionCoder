import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * Linear interpolation helper for smooth 60fps weightless motion.
 */
export function lerp(start: number, end: number, factor: number): number {
  return start + (end - start) * factor;
}

/**
 * Checks if the user prefers reduced motion or is using a touch/coarse pointer device.
 */
export function shouldDisableHeavyMotion(): boolean {
  if (typeof window === 'undefined') return true;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  return reducedMotion || coarsePointer;
}

/**
 * Magnetic pull handler for interactive buttons and links.
 * Moves the element subtly toward the cursor using GPU-friendly translate3d.
 */
export function handleMagneticMove(
  event: ReactMouseEvent<HTMLElement>,
  strength = 0.24,
  disabled = false
): void {
  if (disabled || shouldDisableHeavyMotion()) return;
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const deltaX = (event.clientX - centerX) * strength;
  const deltaY = (event.clientY - centerY) * strength;
  el.style.transform = `translate3d(${deltaX.toFixed(2)}px, ${deltaY.toFixed(2)}px, 0)`;
}

/**
 * Resets magnetic element position smoothly when the cursor leaves.
 */
export function handleMagneticLeave(event: ReactMouseEvent<HTMLElement>): void {
  const el = event.currentTarget;
  el.style.transform = '';
}

/**
 * 3D perspective tilt + radial spotlight tracker for cards and hero blocks.
 * Sets CSS custom properties (--mouse-x, --mouse-y, --tilt-x, --tilt-y) on the target element.
 */
export function handleTiltMove(
  event: ReactMouseEvent<HTMLElement>,
  maxTiltDeg = 4.5,
  disabled = false
): void {
  if (disabled || shouldDisableHeavyMotion()) return;
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  const pctX = Math.max(0, Math.min(1, localX / Math.max(1, rect.width)));
  const pctY = Math.max(0, Math.min(1, localY / Math.max(1, rect.height)));

  const tiltX = (0.5 - pctY) * maxTiltDeg * 2;
  const tiltY = (pctX - 0.5) * maxTiltDeg * 2;

  el.style.setProperty('--mouse-x', `${localX.toFixed(1)}px`);
  el.style.setProperty('--mouse-y', `${localY.toFixed(1)}px`);
  el.style.setProperty('--tilt-x', `${tiltX.toFixed(2)}deg`);
  el.style.setProperty('--tilt-y', `${tiltY.toFixed(2)}deg`);
}

/**
 * Resets 3D tilt properties smoothly when the pointer leaves the card.
 */
export function handleTiltLeave(event: ReactMouseEvent<HTMLElement>): void {
  const el = event.currentTarget;
  el.style.setProperty('--tilt-x', '0deg');
  el.style.setProperty('--tilt-y', '0deg');
}
