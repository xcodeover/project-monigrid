select DATE(created_at) AS log_date, 
    COUNT(*) AS log_count
from system_logs
GROUP BY DATE(created_at)
ORDER BY DATE(created_at) ASC
