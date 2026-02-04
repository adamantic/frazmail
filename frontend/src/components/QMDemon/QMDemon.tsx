'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import './QMDemon.css';

type DemonState = 'idle' | 'running-left' | 'running-right' | 'clicked';

export function QMDemon() {
  const [state, setState] = useState<DemonState>('idle');
  const [lookDirection, setLookDirection] = useState<string>('');
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [runDirection, setRunDirection] = useState<'left' | 'right'>('right');
  const demonRef = useRef<HTMLDivElement>(null);
  const runIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Check for reduced motion preference
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  // Set up running animation interval
  useEffect(() => {
    if (prefersReducedMotion) return;

    const startRunning = () => {
      if (state === 'idle') {
        // Alternate direction each run
        const direction = runDirection;
        setState(direction === 'right' ? 'running-right' : 'running-left');
        setRunDirection(direction === 'right' ? 'left' : 'right');

        // Return to idle after animation completes
        setTimeout(() => {
          setState('idle');
        }, 4000);
      }
    };

    // First run after 10 seconds
    const initialTimeout = setTimeout(startRunning, 10000);

    // Then run every 45 seconds
    runIntervalRef.current = setInterval(startRunning, 45000);

    return () => {
      clearTimeout(initialTimeout);
      if (runIntervalRef.current) {
        clearInterval(runIntervalRef.current);
      }
    };
  }, [state, prefersReducedMotion, runDirection]);

  // Handle click interaction
  const handleClick = useCallback(() => {
    if (prefersReducedMotion) return;

    // Always do flip animation on click
    setState('clicked');
    setTimeout(() => {
      setState('idle');
    }, 600);
  }, [prefersReducedMotion]);

  // Handle mouse movement for eye tracking
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!demonRef.current || prefersReducedMotion) return;

      const rect = demonRef.current.getBoundingClientRect();
      const demonCenterX = rect.left + rect.width / 2;
      const demonCenterY = rect.top + rect.height / 3;

      const deltaX = e.clientX - demonCenterX;
      const deltaY = e.clientY - demonCenterY;

      let direction = '';
      if (Math.abs(deltaX) > 20) {
        direction = deltaX < 0 ? 'look-left' : 'look-right';
      }
      if (Math.abs(deltaY) > 20) {
        direction += deltaY < 0 ? ' look-up' : ' look-down';
      }

      setLookDirection(direction.trim());
    },
    [prefersReducedMotion]
  );

  const handleMouseLeave = useCallback(() => {
    setLookDirection('');
  }, []);

  const isRunning = state === 'running-left' || state === 'running-right';
  const containerClasses = `qm-demon-container ${state}`;
  const demonClasses = `qm-demon ${state} ${lookDirection}`;

  return (
    <div
      className={containerClasses}
      ref={demonRef}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      role="img"
      aria-label="QMDemon mascot - a cute demon that occasionally runs across the screen"
    >
      <div className={demonClasses}>
        {/* Glow effect */}
        <div className="demon-glow" />

        {/* Head with horns */}
        <div className="demon-head">
          <div className="demon-horn left" />
          <div className="demon-horn right" />

          {/* Eyes */}
          <div className="demon-eyes">
            <div className="demon-eye">
              <div className="demon-pupil" />
            </div>
            <div className="demon-eye">
              <div className="demon-pupil" />
            </div>
          </div>

          {/* Blush marks */}
          <div className="demon-blush left" />
          <div className="demon-blush right" />

          {/* Mouth */}
          <div className="demon-mouth" />
        </div>

        {/* Body */}
        <div className="demon-body" />

        {/* Arms */}
        <div className="demon-arm left" />
        <div className="demon-arm right" />

        {/* Legs */}
        <div className="demon-leg left" />
        <div className="demon-leg right" />

        {/* Tail */}
        <div className="demon-tail" />
      </div>
    </div>
  );
}
