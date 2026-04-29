/**
 * Barrel export — maintains backward compatibility with existing imports.
 *
 * Each hook now lives in its own file (SRP):
 *   useApiData.js         — single endpoint polling (currently unused; kept
 *                           as a building block in case a non-widget page
 *                           needs simple polling)
 *   useMultipleApiData.js — multiple endpoints polling (currently unused)
 *   useWidgetApiData.js   — widget grid data management (active)
 */
export { default as useApiData } from "./useApiData.js";
export { default as useMultipleApiData } from "./useMultipleApiData.js";
export { default as useWidgetApiData } from "./useWidgetApiData.js";
