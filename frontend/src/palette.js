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

// ---- Satellite land colours (default base map: NASA Blue Marble on land, contoured relief at sea) ----
export const SAT_BRIGHTNESS_GAMMA = 0.72;  // < 1 brightens (the raw image is dark); 1 = unchanged
export const SAT_SATURATION = 1.3;         // 1 = unchanged
export const SAT_SHADE_STRENGTH = 0.3;     // hillshade on land so mountains read; 0 = flat image
export const SAT_CONTOURS_ON_LAND = false;

// ---- Relief base map ------------------------------------------------------
// Land colour by elevation in metres (hypsometric tint)
export const LAND_STOPS = [
  [0, '#8fb98a'], [150, '#b5cf91'], [400, '#dbd69a'], [800, '#d9bd84'],
  [1500, '#c39e6c'], [2500, '#a88660'], [3500, '#9a8a7e'], [4500, '#c9c4bf'], [6000, '#f4f4f4'],
];
// Ocean colour by depth in metres below sea level (positive numbers)
export const OCEAN_STOPS = [
  [0, '#86a8b8'], [200, '#7195a8'], [1000, '#587b8f'], [2500, '#456579'],
  [4000, '#375367'], [6000, '#2b4154'], [10000, '#1e2e3e'],
];
// Contour lines: elevation thresholds (metres). Land above sea level, sea floor below.
export const LAND_CONTOURS = [250, 500, 1000, 1500, 2000, 3000, 4000, 5000];
export const OCEAN_CONTOURS = [200, 1000, 2000, 3000, 4000, 5000, 6000];
export const CONTOUR_DARKEN_LAND = 0.22;   // 0 = no lines
export const CONTOUR_DARKEN_OCEAN = 0.16;
// Hillshading
export const SHADE_STRENGTH_LAND = 0.65;   // 0 = flat
export const SHADE_STRENGTH_OCEAN = 0.35;
export const VERTICAL_EXAGGERATION_LAND = 14;
export const VERTICAL_EXAGGERATION_OCEAN = 5;
export const SUN_AZIMUTH_DEG = 315;        // from north, clockwise
export const SUN_ALTITUDE_DEG = 40;

// Plain (flat) base map option
export const PLAIN_LAND = [58, 62, 72];
export const PLAIN_OCEAN = [20, 30, 52];

// Country borders / coastline drawn on top
export const BORDER_STYLE = 'rgba(20, 24, 36, 0.45)';
