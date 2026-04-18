/**
 * Pure helpers and constants extracted from ServerResourceCard.jsx (SRP).
 *
 * No React imports — these are intentionally pure so they can be unit
 * tested without rendering and reused by ServerResourceCard sub-components.
 */

export const MAX_SERVERS = 50;
export const MAX_HISTORY = 120;

export const OS_OPTIONS = [
    { value: "windows", label: "Windows (WMI)" },
    { value: "windows-ssh", label: "Windows (PowerShell)" },
    { value: "windows-winrm", label: "Windows (WinRM)" },
    { value: "linux-ubuntu24", label: "Linux (Ubuntu 24.04)" },
    { value: "linux-rhel8", label: "Linux (RHEL 8.x)" },
    { value: "linux-rhel7", label: "Linux (RHEL 7.x)" },
    { value: "linux-generic", label: "Linux (Generic)" },
];

export const DEFAULT_CRITERIA = { cpu: 90, memory: 85, disk: 90 };

export const DETAIL_COLORS = {
    cpu: "#19a0ff",
    memory: "#a29bfe",
    disk: ["#00cdb0", "#ffd166", "#ff8ea0", "#fdcb6e", "#55efc4", "#e17055"],
};

export const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
};

export const generateId = () =>
    `srv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const incrementLabel = (label) => {
    const m = label.match(/^(.*?)(\d+)$/);
    if (m) return m[1] + (parseInt(m[2], 10) + 1);
    return label ? `${label}-2` : "";
};

/** Migrate old single-server config → new multi-server format */
export const migrateServers = (cfg) => {
    if (!cfg) return [];
    if (Array.isArray(cfg.servers)) return cfg.servers;
    if (cfg.osType) {
        return [{
            id: generateId(),
            label: cfg.host || "Server",
            osType: cfg.osType,
            host: cfg.host || "localhost",
            username: cfg.username || "",
            password: cfg.password || "",
            port: cfg.port || "",
            criteria: { ...DEFAULT_CRITERIA },
        }];
    }
    return [];
};

export const formatInterval = (sec) => {
    if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`;
    if (sec >= 60) return `every ${Math.floor(sec / 60)}m`;
    return `every ${sec}s`;
};

export const formatTime = (d) =>
    d ? d.toLocaleTimeString("en-GB", { hour12: false }) : null;

/** Format elapsed seconds as human-readable string (e.g. "3s ago", "2m ago") */
export const formatElapsed = (d) => {
    if (!d) return null;
    const sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
};

export const worstPct = (d) => {
    if (!d) return null;
    return Math.max(
        d.cpu?.usedPct ?? 0,
        d.memory?.usedPct ?? 0,
        ...(d.disks || []).map((dk) => dk.usedPct ?? 0),
    );
};

/** Color by percentage — never red; red only comes from criteria alerts */
export const pctColor = (pct) =>
    pct == null ? "#6b7280" : pct >= 70 ? "#f59e0b" : "#22c55e";

/** Check if any metric exceeds its threshold for a server */
export const checkCriteria = (data, criteria) => {
    if (!data || !criteria) return [];
    const violations = [];
    if (criteria.cpu != null && data.cpu?.usedPct != null && data.cpu.usedPct >= criteria.cpu) {
        violations.push({ type: "CPU", value: data.cpu.usedPct, threshold: criteria.cpu });
    }
    if (criteria.memory != null && data.memory?.usedPct != null && data.memory.usedPct >= criteria.memory) {
        violations.push({ type: "MEM", value: data.memory.usedPct, threshold: criteria.memory });
    }
    if (criteria.disk != null) {
        (data.disks || []).forEach((dk) => {
            if (dk.usedPct != null && dk.usedPct >= criteria.disk) {
                violations.push({ type: `DSK${dk.mount ? ` ${dk.mount}` : ""}`, value: dk.usedPct, threshold: criteria.disk });
            }
        });
    }
    return violations;
};

export const formatChartTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
};
