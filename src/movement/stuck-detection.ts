export type MovementPoint = {
  x: number;
  y: number;
};

export const MOVEMENT_STUCK_DISTANCE_PX = 1.5;
export const MIN_FORWARD_PROGRESS_PX = 6;

export function didMovementGetStuck(
  from: MovementPoint,
  to: MovementPoint,
  thresholdPx: number = MOVEMENT_STUCK_DISTANCE_PX
): boolean {
  const moved = Math.hypot(to.x - from.x, to.y - from.y);
  return moved < thresholdPx;
}

export function isForwardProgressBlocked(
  from: MovementPoint,
  to: MovementPoint,
  towardTarget: -1 | 1,
  minForwardPx: number = MIN_FORWARD_PROGRESS_PX
): boolean {
  const forwardProgress = (to.x - from.x) * towardTarget;
  return forwardProgress < minForwardPx;
}
