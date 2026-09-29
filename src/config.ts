// All units are SI: meters, seconds, kilograms, radians.
// Table coordinates: X along the long axis, Z along the short axis, Y up.
// The cloth surface is at y = 0 and the table is centred on the origin.

export const BALL_RADIUS = 0.028575;
export const BALL_MASS = 0.17;

export const TABLE = {
  length: 2.24,
  width: 1.12,
  cushionWidth: 0.05,
  cushionHeight: BALL_RADIUS * 1.3,
  railWidth: 0.13,
  railHeight: BALL_RADIUS * 1.55,
  surfaceHeight: 0.8,
  cornerCut: 0.088,
  sideCut: 0.066,
  jawDepth: 0.055,
  cornerPocketRadius: 0.068,
  sidePocketRadius: 0.064,
} as const;

export const HALF_L = TABLE.length / 2;
export const HALF_W = TABLE.width / 2;

export const HEAD_STRING_X = -TABLE.length / 4;
export const FOOT_SPOT_X = TABLE.length / 4;

export const PHYSICS = {
  gravity: 9.81,
  substep: 1 / 1200,
  slidingFriction: 0.2,
  rollingFriction: 0.016,
  spinFriction: 0.022,
  ballRestitution: 0.94,
  ballFriction: 0.05,
  cushionRestitution: 0.78,
  cushionFriction: 0.2,
  linearSleep: 0.004,
  angularSleep: 0.25,
} as const;

export const SHOT = {
  maxSpeed: 7.5,
  minSpeed: 0.12,
  maxTipOffset: 0.5,
} as const;
