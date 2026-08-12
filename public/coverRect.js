// Which part of the camera frame the preview is actually showing.
//
// The video element is sized by CSS and drawn with `object-fit: cover`: the frame
// is scaled up until it fills the box, and whatever overflows is cropped away. So
// the region a person sees — and frames the mark inside — is not the whole frame,
// and not its centre square either. It is the centred sub-rectangle carrying the
// BOX's aspect ratio.
//
// The decoder has to be handed that same rectangle. Give it anything else and the
// viewfinder is lying: the mark sits where you put it on screen but somewhere
// else in the pixels being decoded, and framing becomes guesswork.
//
// Ratios are compared by cross-multiplication and the sides derived by
// multiply-then-divide, so the exact cases (a 4:3 box, a 1080x1920 phone frame)
// land on whole pixels instead of drifting by a float epsilon.

/**
 * @param {number} frameW  intrinsic video width  (video.videoWidth)
 * @param {number} frameH  intrinsic video height (video.videoHeight)
 * @param {number} boxW    displayed element width  (video.clientWidth)
 * @param {number} boxH    displayed element height (video.clientHeight)
 * @returns {{sx:number, sy:number, sw:number, sh:number}} source rect, in frame pixels
 */
export function coverSourceRect(frameW, frameH, boxW, boxH) {
  // Before layout settles the box can measure zero. Decoding the whole frame is
  // wrong but harmless; dividing by zero is not.
  if (!(boxW > 0) || !(boxH > 0)) return { sx: 0, sy: 0, sw: frameW, sh: frameH };

  if (frameW * boxH > frameH * boxW) {
    // Frame is wider than the box: full height, sides cropped.
    const sw = (frameH * boxW) / boxH;
    return { sx: (frameW - sw) / 2, sy: 0, sw, sh: frameH };
  }
  // Frame is taller than (or as wide as) the box: full width, top and bottom cropped.
  const sh = (frameW * boxH) / boxW;
  return { sx: 0, sy: (frameH - sh) / 2, sw: frameW, sh };
}
