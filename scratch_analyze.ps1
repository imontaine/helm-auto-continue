$json = Get-Content 'c:\Users\Work\Desktop\misc coding\helm\.helm-diag\diag_error_retry_1_2026-04-20T10-17-23-501Z.json' -Raw | ConvertFrom-Json

Write-Host "=== TRAJECTORY INFO ==="
if ($json.recentTrajectories) {
    $t = $json.recentTrajectories[0]
    Write-Host "Summary: $($t.summary)"
    Write-Host "LastStepIndex: $($t.lastStepIndex)"
    Write-Host "LastModifiedTime: $($t.lastModifiedTime)"
    Write-Host "GoogleAgentId: $($t.googleAgentId)"
} else {
    Write-Host "No trajectories"
}

Write-Host ""
Write-Host "=== AGENT WINDOW CONSOLE LOGS (last 50 lines) ==="
if ($json.agentWindowConsoleLogs) {
    $logs = if ($json.agentWindowConsoleLogs.logs) { $json.agentWindowConsoleLogs.logs } else { $json.agentWindowConsoleLogs -split "`n" }
    $logs | Select-Object -Last 50 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host "No agentWindowConsoleLogs"
}

Write-Host ""
Write-Host "=== LANGUAGE SERVER LOGS (last 30 lines) ==="
if ($json.languageServerLogs) {
    $logs = if ($json.languageServerLogs.logs) { $json.languageServerLogs.logs } else { $json.languageServerLogs -split "`n" }
    $logs | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host "No languageServerLogs"
}

Write-Host ""
Write-Host "=== TOP-LEVEL KEYS ==="
$json.PSObject.Properties.Name | ForEach-Object { Write-Host $_ }
