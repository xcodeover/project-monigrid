import React from "react";
import { createPortal } from "react-dom";

/**
 * Row detail popup extracted from ApiCard (SRP).
 *
 * Pure presentational — receives the live row, the parent widget title,
 * and an `onClose` callback. The "live update" tracking that resolves
 * `selectedRow` to the latest data row stays in ApiCard so this
 * component does not need to know about the data table.
 */
const renderDetailValue = (value) => {
    if (value === null || value === undefined)
        return <span className='detail-null'>—</span>;
    if (typeof value === "boolean")
        return (
            <span
                className={value ? "detail-bool-true" : "detail-bool-false"}
            >
                {value ? "true" : "false"}
            </span>
        );
    if (typeof value === "object")
        return (
            <pre className='detail-json'>
                {JSON.stringify(value, null, 2)}
            </pre>
        );
    if (typeof value === "number")
        return (
            <span className='detail-number'>{value.toLocaleString()}</span>
        );
    return <span className='detail-string'>{String(value)}</span>;
};

const ApiCardRowDetailModal = ({ row, title, onClose }) => {
    if (!row) return null;

    return createPortal(
        <div className='row-detail-overlay' onClick={onClose}>
            <div
                className='row-detail-popup'
                onClick={(e) => e.stopPropagation()}
            >
                <div className='row-detail-header'>
                    <div>
                        <h5>Row Detail</h5>
                        <p>{title}</p>
                    </div>
                    <button
                        type='button'
                        className='close-settings-btn'
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </div>
                <div className='row-detail-body'>
                    <table className='row-detail-table'>
                        <tbody>
                            {Object.entries(row)
                                .filter(([k]) => !k.startsWith("_"))
                                .map(([key, value]) => (
                                    <tr key={key} className='row-detail-row'>
                                        <td className='row-detail-key'>
                                            {key}
                                        </td>
                                        <td className='row-detail-val'>
                                            {renderDetailValue(value)}
                                        </td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </div>
                <div className='row-detail-footer'>
                    <span className='row-detail-live-indicator'>
                        <span className='live-dot' />
                        실시간 반영 중
                    </span>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default ApiCardRowDetailModal;
