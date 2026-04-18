/**
 * Barrel export — maintains backward compatibility with existing imports.
 *
 * Each hook now lives in its own file (SRP):
 *   useApiData.js         — single endpoint polling
 *   useMultipleApiData.js — multiple endpoints polling
 *   useWidgetApiData.js   — widget grid data management
 */
export { default as useApiData } from "./useApiData.js";
export { default as useMultipleApiData } from "./useMultipleApiData.js";
export { default as useWidgetApiData } from "./useWidgetApiData.js";
