# PowerShell script to stop a service by port
# Usage: .\stop-service.ps1 -Port 1234

param(
    [Parameter(Mandatory=$true)]
    [int]$Port
)

Write-Host "Stopping service listening on port $Port..."

# Find the process listening on the specified port
$id = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | 
      Select-Object -First 1 -ExpandProperty OwningProcess

if ($id) {
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    
    if ($process) {
        $processName = $process.ProcessName
        Write-Host "Found process $processName (PID $id) listening on port $Port"
        
        # Stop the process
        Stop-Process -Id $id -Force
        
        # Wait a moment to ensure it's stopped
        Start-Sleep -Milliseconds 500
        
        # Verify it's stopped
        $stillRunning = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($stillRunning) {
            Write-Host "Warning: Process $id is still running after stop attempt"
            exit 1
        }
        
        Write-Host "Successfully stopped process $id ($processName)"
        exit 0
    } else {
        Write-Host "Process ID $id not found"
        exit 1
    }
} else {
    Write-Host "No process found listening on port $Port"
    exit 0
}
