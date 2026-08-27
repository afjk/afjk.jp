export const XR_QUALITY_PRESETS = Object.freeze({
  quality: Object.freeze({
    label: 'Quality',
    framebufferScale: 1,
    foveation: 0,
  }),
  balanced: Object.freeze({
    label: 'Balanced',
    framebufferScale: 0.85,
    foveation: 0.3,
  }),
  performance: Object.freeze({
    label: 'Performance',
    framebufferScale: 0.78,
    foveation: 0.55,
  }),
});

export const DEFAULT_XR_QUALITY_PRESET = 'quality';
export const XR_LOCOMOTION_SPEED = 1.5;
export const XR_VERTICAL_LOCOMOTION_SPEED = 1;
export const XR_SNAP_TURN_DEGREES = 30;
export const PICO_A_BUTTON_INDEX = 4;
export const PICO_B_BUTTON_INDEX = 5;

export function resolveXrQualityConfig(searchParams) {
  const requested = searchParams.get('quality');
  const preset = XR_QUALITY_PRESETS[requested] ? requested : DEFAULT_XR_QUALITY_PRESET;
  return { preset, ...XR_QUALITY_PRESETS[preset] };
}

export function playCanvasXrStartScale(targetScale, devicePixelRatio, maxPixelRatio) {
  const safeDevicePixelRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const safeMaxPixelRatio = Number.isFinite(maxPixelRatio) && maxPixelRatio > 0
    ? maxPixelRatio
    : 1;
  // PlayCanvas multiplies the start option by maxPixelRatio / devicePixelRatio
  // before constructing XRWebGLLayer. Compensate so both engines reach the
  // target WebXR framebuffer scale even when desktop pixel ratio is capped.
  return targetScale * safeDevicePixelRatio / safeMaxPixelRatio;
}

export function readXrThumbstick(gamepad, deadzone = 0.2) {
  const axes = gamepad?.axes;
  if (!axes || axes.length < 2) return { x: 0, y: 0, active: false };

  // WebXR's xr-standard mapping reserves axes 0/1 for a primary 2D input and
  // exposes the thumbstick at 2/3. Fall back to the last pair for controllers
  // that only report one 2D axis set.
  const offset = axes.length >= 4 ? 2 : axes.length - 2;
  const rawX = Number(axes[offset]) || 0;
  const rawY = Number(axes[offset + 1]) || 0;
  const magnitude = Math.min(1, Math.hypot(rawX, rawY));
  if (magnitude <= deadzone) return { x: 0, y: 0, active: false };

  const scaledMagnitude = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  const scale = scaledMagnitude / magnitude;
  return { x: rawX * scale, y: rawY * scale, active: true };
}

export function readPicoVerticalButtons(gamepad) {
  const isPressed = (index) => {
    const button = gamepad?.buttons?.[index];
    return Boolean(button?.pressed || button?.value > 0.5);
  };
  const aPressed = isPressed(PICO_A_BUTTON_INDEX);
  const bPressed = isPressed(PICO_B_BUTTON_INDEX);
  return {
    aPressed,
    bPressed,
    direction: (bPressed ? 1 : 0) - (aPressed ? 1 : 0),
  };
}
