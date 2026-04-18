import React, { useState } from "react";
import { doesRowMatchCriteria, evaluateCriteria } from "../utils/helpers";
import "./DynamicTable.css";

/**
 * 동적 테이블 컴포넌트
 * JSON 데이터 구조에 관계없이 자동으로 테이블 생성
 *
 * Props:
 *   - data: 테이블 데이터 (배열 또는 객체)
 *   - title: 테이블 제목
 *   - columns: (선택) 특정 컬럼만 표시하려면 지정
 *   - columnLabels: (선택) 컬럼 이름 커스터마이징
 *   - maxRows: (선택) 표시할 최대 행 수
 *   - sortable: (선택) 정렬 가능 여부
 *   - onRowClick: (선택) 행 클릭 핸들러 (단일 클릭)
 *   - onRowDoubleClick: (선택) 행 더블클릭 핸들러
 */
const DynamicTable = ({
    data,
    title = "Data Table",
    columns = null,
    columnLabels = {},
    columnWidths = {},
    criteria = {},
    showAlertsOnly = false,
    fontSize = 13,
    maxRows = 50,
    sortable = true,
    onRowClick = null,
    onRowDoubleClick = null,
    loading = false,
    error = null,
    showHeader = true,
}) => {
    const [sortConfig, setSortConfig] = useState({
        key: null,
        direction: "asc",
    });
    const [expandedRows, setExpandedRows] = useState(new Set());

    // 데이터가 배열인지 객체인지 확인하고 배열로 정규화
    const normalizeData = (rawData) => {
        if (Array.isArray(rawData)) {
            return rawData;
        } else if (typeof rawData === "object" && rawData !== null) {
            // 객체인 경우 배열로 변환
            return Object.keys(rawData).map((key) => ({
                _key: key,
                ...rawData[key],
            }));
        }
        return [];
    };

    const dataArray = normalizeData(data);

    if (loading) {
        return (
            <div className='dynamic-table-container'>
                {showHeader && (
                    <div className='table-header'>
                        <h3>{title}</h3>
                    </div>
                )}
                <div className='loading-state'>
                    <div className='spinner'></div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className='dynamic-table-container'>
                {showHeader && (
                    <div className='table-header'>
                        <h3>{title}</h3>
                    </div>
                )}
                <div className='error-state'>
                    <p>⚠️ 오류: {error}</p>
                </div>
            </div>
        );
    }

    if (!dataArray || dataArray.length === 0) {
        return (
            <div className='dynamic-table-container'>
                {showHeader && (
                    <div className='table-header'>
                        <h3>{title}</h3>
                    </div>
                )}
                <div className='empty-state'>
                    <p>데이터가 없습니다</p>
                </div>
            </div>
        );
    }

    // 컬럼 추출
    const getAllColumns = () => {
        if (columns) {
            return columns;
        }

        const columnSet = new Set();
        dataArray.forEach((row) => {
            if (typeof row === "object") {
                Object.keys(row).forEach((key) => {
                    if (!key.startsWith("_")) {
                        columnSet.add(key);
                    }
                });
            }
        });

        return Array.from(columnSet);
    };

    const tableColumns = getAllColumns();

    // 정렬 기능
    const handleSort = (key) => {
        if (!sortable) return;

        let direction = "asc";
        if (sortConfig.key === key && sortConfig.direction === "asc") {
            direction = "desc";
        }
        setSortConfig({ key, direction });
    };

    const filteredData = showAlertsOnly
        ? dataArray.filter((row) => doesRowMatchCriteria(row, criteria))
        : dataArray;

    const hasCriteria = Object.keys(criteria).some(
        (col) =>
            criteria[col]?.enabled &&
            String(criteria[col]?.value ?? "").trim() !== "",
    );

    // 데이터 정렬
    const getSortedData = () => {
        let working = [...filteredData];

        // criteria 매칭 행을 상단으로 끌어올림
        if (hasCriteria && !showAlertsOnly) {
            working.sort((a, b) => {
                const aMatch = doesRowMatchCriteria(a, criteria) ? 0 : 1;
                const bMatch = doesRowMatchCriteria(b, criteria) ? 0 : 1;
                return aMatch - bMatch;
            });
        }

        if (sortConfig.key) {
            // stable sort: criteria 그룹 내에서만 정렬
            working.sort((a, b) => {
                if (hasCriteria && !showAlertsOnly) {
                    const aMatch = doesRowMatchCriteria(a, criteria) ? 0 : 1;
                    const bMatch = doesRowMatchCriteria(b, criteria) ? 0 : 1;
                    if (aMatch !== bMatch) return aMatch - bMatch;
                }

                const aValue = a[sortConfig.key];
                const bValue = b[sortConfig.key];

                if (aValue === null || aValue === undefined) return 1;
                if (bValue === null || bValue === undefined) return -1;

                if (typeof aValue === "string") {
                    return sortConfig.direction === "asc"
                        ? aValue.localeCompare(bValue)
                        : bValue.localeCompare(aValue);
                }

                return sortConfig.direction === "asc"
                    ? aValue - bValue
                    : bValue - aValue;
            });
        }

        return working.slice(0, maxRows);
    };

    const sortedData = getSortedData();

    if (filteredData.length === 0) {
        return (
            <div className='dynamic-table-container'>
                {showHeader && (
                    <div className='table-header'>
                        <h3>{title}</h3>
                    </div>
                )}
                <div className='empty-state'>
                    <p>Criteria 조건에 맞는 데이터가 없습니다</p>
                </div>
            </div>
        );
    }

    const isAbnormalByCriteria = (column, value) =>
        evaluateCriteria(criteria?.[column], value);

    // 셀 값 렌더링
    const renderCell = (value) => {
        if (value === null || value === undefined) {
            return <span className='null-value'>-</span>;
        }

        if (typeof value === "boolean") {
            return (
                <span className={value ? "bool-true" : "bool-false"}>
                    {value ? "✓" : "✗"}
                </span>
            );
        }

        if (typeof value === "object") {
            return (
                <button
                    className='expand-btn'
                    onClick={() => console.log(value)}
                    title='click to view details'
                >
                    [ object ]
                </button>
            );
        }

        if (typeof value === "number") {
            return (
                <span className='number-value'>{value.toLocaleString()}</span>
            );
        }

        const strValue = String(value);

        // 상태 값에 따른 색상 처리
        if (
            ["success", "healthy", "active", "ok", "online"].includes(
                strValue.toLowerCase(),
            )
        ) {
            return <span className='status-success'>{strValue}</span>;
        }

        if (
            ["error", "failed", "critical", "inactive", "offline"].includes(
                strValue.toLowerCase(),
            )
        ) {
            return <span className='status-error'>{strValue}</span>;
        }

        if (["warning", "pending", "busy"].includes(strValue.toLowerCase())) {
            return <span className='status-warning'>{strValue}</span>;
        }

        return strValue.length > 50 ? (
            <span title={strValue}>{strValue.substring(0, 50)}...</span>
        ) : (
            strValue
        );
    };

    // 컬럼 라벨 가져오기
    const getColumnLabel = (column) => {
        if (columnLabels[column]) {
            return columnLabels[column];
        }
        return column
            .replace(/_/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase());
    };

    const getDefaultColumnWidth = (column) => {
        const headerText = getColumnLabel(column);
        const estimatedWidth = headerText.length * 9 + 28;
        return Math.max(80, Math.min(420, estimatedWidth));
    };

    const getColumnWidth = (column) =>
        columnWidths[column] ?? getDefaultColumnWidth(column);

    return (
        <div className='dynamic-table-container'>
            {showHeader && (
                <div className='table-header'>
                    <h3>{title}</h3>
                    <span className='row-count'>{sortedData.length} rows</span>
                </div>
            )}

            <div className='table-wrapper'>
                <table
                    className='dynamic-table'
                    style={{ fontSize: `${fontSize}px` }}
                >
                    <colgroup>
                        {tableColumns.map((column) => (
                            <col
                                key={column}
                                style={{
                                    width: `${getColumnWidth(column)}px`,
                                    minWidth: `${getColumnWidth(column)}px`,
                                }}
                            />
                        ))}
                    </colgroup>
                    <thead>
                        <tr>
                            {tableColumns.map((column) => (
                                <th
                                    key={column}
                                    onClick={() => handleSort(column)}
                                    className={sortable ? "sortable" : ""}
                                    title={sortable ? "click to sort" : ""}
                                >
                                    <div className='column-header'>
                                        <span>{getColumnLabel(column)}</span>
                                        {sortable &&
                                            sortConfig.key === column && (
                                                <span className='sort-indicator'>
                                                    {sortConfig.direction ===
                                                    "asc"
                                                        ? "▲"
                                                        : "▼"}
                                                </span>
                                            )}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sortedData.map((row, rowIndex) => (
                            <tr
                                key={row._key || rowIndex}
                                className={
                                    onRowClick || onRowDoubleClick
                                        ? "clickable"
                                        : ""
                                }
                                onClick={() => onRowClick && onRowClick(row)}
                                onDoubleClick={() =>
                                    onRowDoubleClick && onRowDoubleClick(row)
                                }
                            >
                                {tableColumns.map((column) => (
                                    <td
                                        key={`${rowIndex}-${column}`}
                                        className={
                                            isAbnormalByCriteria(
                                                column,
                                                row[column],
                                            )
                                                ? "abnormal-cell"
                                                : ""
                                        }
                                        style={{
                                            width: `${getColumnWidth(column)}px`,
                                            minWidth: `${getColumnWidth(column)}px`,
                                        }}
                                    >
                                        {renderCell(row[column])}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {filteredData.length > maxRows && (
                <div className='table-footer'>
                    <p>
                        Showing {sortedData.length} of {filteredData.length}{" "}
                        rows
                    </p>
                </div>
            )}
        </div>
    );
};

export default DynamicTable;
