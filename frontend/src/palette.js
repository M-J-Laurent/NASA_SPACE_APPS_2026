// All the colours / look-and-feel knobs for the map in one place. Edit and save: the page hot-reloads.

// ---- Data overlay colours -------------------------------------------------
// Rate of change: falling -> no change -> rising
export const DIVERGING_STOPS = [[0, '#2468d8'], [0.5, '#f0ece3'], [1, '#d63a26']];
// Combined "how much is changing" score: little -> a lot
export const SEQUENTIAL_STOPS = [[0, '#1b1440'], [0.4, '#6a2c91'], [0.7, '#e0527e'], [1, '#ffe08a']];
// Significance: no evidence -> very strong evidence
export const SIGNIFICANCE_STOPS = [[0, '#1b2036'], [0.4, '#2a7f9c'], [0.75, '#6fd08c'], [1, '#f6f2a4']];

// How opaque the data layer is over the relief map (0 = invisible, 1 = solid).
export const OVERLAY_ALPHA = 0.86;
// "Faded where not significant": significance weight goes from 0 at p >= SIG_P_HIGH to 1 at p <= SIG_P_LOW.
// Cells with weight 0 show the plain relief map, so not-significant areas are easy to spot.
export const SIG_P_HIGH = 0.1;
export const SIG_P_LOW = 0.01;
// Where a layer has no data (a real gap): the relief map is greyed and darkened by this much.
export const NO_DATA_DARKEN = 0.55;
export const NO_DATA_DESATURATE = 0.85;

// ---- Base map (a pre-rendered 8192x4096 image: NASA Blue Marble on land, contoured sea floor; see preprocessing/basemap.py) ----
// Live tweaks applied on top of the image:
export const SAT_BRIGHTNESS_GAMMA = 0.72;  // < 1 brightens the (dark) satellite land; 1 = unchanged
export const SAT_SATURATION = 1.3;         // 1 = unchanged
// The sea-floor colours, contour lines and hillshading are baked in preprocessing/basemap.py (edit and re-run it).

// "Plain dark" base map option
export const PLAIN_LAND = [58, 62, 72];
export const PLAIN_OCEAN = [20, 30, 52];

// Country borders (vector lines)
export const BORDER_COLOR = 0x141824;
export const BORDER_OPACITY = 0.55;
