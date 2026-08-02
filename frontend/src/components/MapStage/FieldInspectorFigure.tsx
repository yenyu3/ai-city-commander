import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./FieldInspectorFigure.module.css";

export interface FieldInspectorFigureProps {
  /** Rendered width in px; height follows the character's fixed aspect ratio. */
  size?: number;
  /** Walking-cycle pose while dragging. Idle uses a compact celebration loop. */
  walking?: boolean;
  /** Set to a value that changes on every placement/reposition to replay the landing hop. Omit for no landing animation (e.g. while being carried). */
  placementKey?: number | string;
  /** Turns off every animation for compact/static use. */
  animated?: boolean;
  className?: string;
  "aria-label"?: string;
}

const VIEW_W = 44;
const VIEW_H = 58;
const SPECIAL_MOVE_MIN_DELAY_MS = 7000;
const SPECIAL_MOVE_JITTER_MS = 3000;
const CELEBRATION_ANIM_MS = 2600;

type SpecialMove = "hop" | "siu" | "bellingham";

function nextSpecialMove(move: SpecialMove): SpecialMove {
  if (move === "hop") return "siu";
  if (move === "siu") return "bellingham";
  return "hop";
}

export default function FieldInspectorFigure({
  size = 40,
  walking = false,
  placementKey,
  animated = true,
  className,
  "aria-label": ariaLabel,
}: FieldInspectorFigureProps) {
  const [specialMove, setSpecialMove] = useState<SpecialMove | null>(null);
  const nextSpecialMoveRef = useRef<SpecialMove>("hop");
  const scheduleTimeoutRef = useRef<number | undefined>(undefined);
  const clearTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!animated || walking) {
      setSpecialMove(null);
      window.clearTimeout(scheduleTimeoutRef.current);
      window.clearTimeout(clearTimeoutRef.current);
      return;
    }

    const scheduleNext = () => {
      const delay = SPECIAL_MOVE_MIN_DELAY_MS + Math.random() * SPECIAL_MOVE_JITTER_MS;
      scheduleTimeoutRef.current = window.setTimeout(() => {
        const current = nextSpecialMoveRef.current;
        setSpecialMove(current);
        nextSpecialMoveRef.current = nextSpecialMove(current);
        clearTimeoutRef.current = window.setTimeout(() => {
          setSpecialMove(null);
          scheduleNext();
        }, CELEBRATION_ANIM_MS);
      }, delay);
    };

    scheduleNext();

    return () => {
      window.clearTimeout(scheduleTimeoutRef.current);
      window.clearTimeout(clearTimeoutRef.current);
    };
  }, [animated, walking]);

  const isHop = specialMove === "hop";
  const isSiu = specialMove === "siu";
  const isBellingham = specialMove === "bellingham";
  const isResting = animated && !walking && !specialMove;
  const bobClass = !animated ? "" : walking ? styles.walkBob : specialMove ? "" : styles.idleBob;

  // Contralateral gait: each leg swings opposite the arm on the same side.
  // Triggered special moves rotate every 10-15s: hop, Siu, then Bellingham.
  const legClass = animated && walking ? styles.swingA : isHop ? styles.hopLegA : isSiu ? styles.siuLegA : isBellingham ? styles.bellinghamLegA : isResting ? styles.idleStepLegA : "";
  const legClassAlt = animated && walking ? styles.swingB : isHop ? styles.hopLegB : isSiu ? styles.siuLegB : isBellingham ? styles.bellinghamLegB : isResting ? styles.idleStepLegB : "";
  const armClass = animated && walking ? styles.swingB : isHop ? styles.hopArmA : isSiu ? styles.siuArmA : isBellingham ? styles.bellinghamArmA : isResting ? styles.idleStepArmA : "";
  const armClassAlt = animated && walking ? styles.swingA : isHop ? styles.hopArmB : isSiu ? styles.siuArmB : isBellingham ? styles.bellinghamArmB : isResting ? styles.idleStepArmB : "";
  const shadowClass = animated && walking ? styles.shadowPulse : isHop ? styles.hopShadow : isSiu ? styles.siuShadow : isBellingham ? styles.bellinghamShadow : isResting ? styles.idleStepShadow : "";
  const bodyClass = isHop ? styles.hopBody : isSiu ? styles.siuBody : isBellingham ? styles.bellinghamBody : "";

  const character: ReactNode = (
    <g className={bodyClass}>
      <g className={bobClass}>
        <g className={`${styles.limb} ${legClass}`}>
          <rect className={styles.legBack} x={16.4} y={41} width={5} height={12.5} rx={2.5} />
        </g>
        <g className={`${styles.limb} ${legClassAlt}`}>
          <rect className={styles.legFront} x={22.6} y={41} width={5} height={12.5} rx={2.5} />
        </g>

        <path
          className={styles.torso}
          d="M14 30c0-3 3.6-5 8-5s8 2 8 5l1.6 10c.3 2-1 3.4-3 3.4H15.4c-2 0-3.3-1.4-3-3.4z"
        />
        <rect className={styles.torsoSheen} x={15.6} y={27.5} width={2.6} height={13} rx={1.3} />

        <g className={styles.headGroup}>
          <circle className={styles.head} cx={22} cy={19} r={9} />
          <path className={styles.helmet} d="M12.5 15a9.5 9.5 0 0 1 19 0z" />
          <ellipse className={styles.helmetBrim} cx={22} cy={15} rx={11} ry={1.8} />
          <ellipse className={styles.helmetDot} cx={22} cy={8.4} rx={1.5} ry={1.2} />

          <circle className={styles.eye} cx={18.4} cy={19.3} r={1.05} />
          <circle className={styles.eye} cx={25.6} cy={19.3} r={1.05} />
          <path className={styles.smile} d="M18.6 22.8c1.1 1.5 5.7 1.5 6.8 0" />
        </g>

        <g className={`${styles.limb} ${armClass}`}>
          <rect className={styles.arm} x={9} y={29} width={4.6} height={11} rx={2.3} />
        </g>

        <g className={`${styles.limb} ${armClassAlt}`}>
          <rect className={styles.arm} x={30.4} y={29} width={4.6} height={11} rx={2.3} />
        </g>
      </g>
    </g>
  );

  return (
    <svg
      className={[styles.figure, className].filter(Boolean).join(" ")}
      width={size}
      height={(size * VIEW_H) / VIEW_W}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <ellipse className={`${styles.shadow} ${shadowClass}`} cx={22} cy={55} rx={12} ry={3.2} />
      {animated && placementKey !== undefined ? (
        <g key={placementKey} className={styles.landing}>
          {character}
        </g>
      ) : (
        <g className={animated ? styles.landing : undefined}>{character}</g>
      )}
    </svg>
  );
}
