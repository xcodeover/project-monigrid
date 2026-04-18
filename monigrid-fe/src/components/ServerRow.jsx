import { OS_OPTIONS, pctColor, worstPct } from "./serverResourceHelpers";

/**
 * Single-line server row display extracted from ServerResourceCard (SRP).
 *
 * Pure presentational — receives the server descriptor, the latest data
 * snapshot, alert violations, and an `onDoubleClick` callback. Owns no
 * state.
 */

const InlineBar = ({ pct, alert }) => {
    const color = alert ? "#ef4444" : pctColor(pct);
    return (
        <div className='srv-inline-bar'>
            <div className={`srv-inline-bar-track${alert ? " srv-alert" : ""}`}>
                <div
                    className='srv-inline-bar-fill'
                    style={{ width: `${pct ?? 0}%`, backgroundColor: color }}
                />
            </div>
            <span
                className={`srv-inline-bar-val${alert ? " srv-alert" : ""}`}
                style={{ color }}
            >
                {pct != null ? `${pct}%` : "-"}
            </span>
        </div>
    );
};

const ServerRow = ({
    server,
    data,
    loading,
    error,
    displayMode,
    violations,
    diskCycleIdx,
    onDoubleClick,
}) => {
    const d = data;
    const hasAlert = violations && violations.length > 0;
    const worst = worstPct(d);
    const dotColor = hasAlert
        ? "#ef4444"
        : error && !d
          ? "#ef4444"
          : pctColor(worst);
    const compact = displayMode === "compact" || displayMode === "mini";
    const crit = server.criteria || {};

    // Pick which disk(s) to show; compact/normal show 1 (cycling), wide shows up to 3
    const disks = d?.disks || [];
    const diskSlice = (() => {
        if (disks.length === 0) return [];
        if (displayMode === "wide") return disks.slice(0, 3);
        // Show 1 disk, cycling through all drives each refresh
        const idx = (diskCycleIdx ?? 0) % disks.length;
        return [disks[idx]];
    })();

    const osLabel =
        OS_OPTIONS.find((o) => o.value === server.osType)?.label ||
        server.osType;
    const tooltip = [
        `이름: ${server.label || "(없음)"}`,
        `OS: ${osLabel}`,
        `호스트: ${server.host || "-"}${server.port ? `:${server.port}` : ""}`,
        `임계값 — CPU: ${crit.cpu ?? "-"}% / MEM: ${crit.memory ?? "-"}% / DISK: ${crit.disk ?? "-"}%`,
        d?.cpu?.usedPct != null ? `현재 CPU: ${d.cpu.usedPct}%` : null,
        d?.memory?.usedPct != null ? `현재 MEM: ${d.memory.usedPct}%` : null,
        ...disks.map((dk) =>
            dk.usedPct != null
                ? `현재 DISK(${dk.mount || "?"}): ${dk.usedPct}%`
                : null,
        ),
        hasAlert
            ? `⚠ Alert: ${violations.map((v) => `${v.type} ${v.value}% ≥ ${v.threshold}%`).join(", ")}`
            : null,
        error ? `오류: ${typeof error === "string" ? error : "Error"}` : null,
    ]
        .filter(Boolean)
        .join("\n");

    return (
        <div
            className={`srv-row mode-${displayMode}${hasAlert ? " srv-alert" : ""}`}
            onDoubleClick={onDoubleClick}
            title={tooltip}
        >
            <span
                className={`srv-row-dot${hasAlert ? " pulse" : ""}`}
                style={{ backgroundColor: dotColor }}
            />
            <span className='srv-row-label'>
                {server.label || server.host}
            </span>
            {!compact && (
                <span className='srv-row-host'>
                    {server.host}
                    {server.port ? `:${server.port}` : ""}
                </span>
            )}

            {loading && !d && <span className='srv-row-spinner' />}

            {error && !d ? (
                <span className='srv-row-error'>
                    {typeof error === "string" ? error : "Error"}
                </span>
            ) : d ? (
                <div className='srv-row-metrics'>
                    <div className='srv-metric'>
                        <span className='srv-metric-label'>CPU</span>
                        <InlineBar
                            pct={d.cpu?.usedPct}
                            alert={
                                crit.cpu != null && d.cpu?.usedPct >= crit.cpu
                            }
                        />
                    </div>
                    <div className='srv-metric'>
                        <span className='srv-metric-label'>MEM</span>
                        <InlineBar
                            pct={d.memory?.usedPct}
                            alert={
                                crit.memory != null &&
                                d.memory?.usedPct >= crit.memory
                            }
                        />
                    </div>
                    {diskSlice.map((dk, i) => {
                        const mt = dk.mount || "";
                        const shortMount =
                            mt.length > 2 ? mt.slice(0, 2) + "…" : mt;
                        return (
                            <div className='srv-metric' key={dk.mount || i}>
                                <span
                                    className='srv-metric-label'
                                    title={mt ? `DISK (${mt})` : "DISK"}
                                >
                                    DISK{shortMount ? `(${shortMount})` : ""}
                                </span>
                                <InlineBar
                                    pct={dk.usedPct}
                                    alert={
                                        crit.disk != null &&
                                        dk.usedPct >= crit.disk
                                    }
                                />
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
};

export default ServerRow;
