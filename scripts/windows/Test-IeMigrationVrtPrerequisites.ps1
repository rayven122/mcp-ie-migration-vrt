[CmdletBinding()]
param(
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This prerequisite check must run on Windows.'
}

function New-CheckResult {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Value,
        [string]$Remediation
    )

    [pscustomobject]@{
        name = $Name
        passed = $Passed
        value = $Value
        remediation = if ($Passed) { $null } else { $Remediation }
    }
}

$checks = [System.Collections.Generic.List[object]]::new()
$edgePaths = @(
    "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$edgePath = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
$edgeDisplay = if ($edgePath) { $edgePath } else { 'not found' }
$checks.Add((New-CheckResult 'edge' ($null -ne $edgePath) $edgeDisplay 'Install Microsoft Edge.'))

$node = Get-Command node -ErrorAction SilentlyContinue
$nodeVersion = if ($node) { (& node --version) -replace '^v', '' } else { $null }
$nodeSupported = $nodeVersion -and ([version]$nodeVersion -ge [version]'18.0.0')
$nodeDisplay = if ($nodeVersion) { $nodeVersion } else { 'not found' }
$checks.Add((New-CheckResult 'node' $nodeSupported $nodeDisplay 'Install Node.js 18 or newer when running outside the Claude Desktop bundled runtime.'))

$explorer = Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId }
$checks.Add((New-CheckResult 'interactive-session' ($null -ne $explorer) "session $((Get-Process -Id $PID).SessionId)" 'Run from the logged-on, non-elevated interactive Windows session.'))

$edgePolicyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
$integrationLevel = (Get-ItemProperty -Path $edgePolicyPath -Name InternetExplorerIntegrationLevel -ErrorAction SilentlyContinue).InternetExplorerIntegrationLevel
$checks.Add((New-CheckResult 'ie-mode-policy' ($integrationLevel -eq 1) "$integrationLevel" 'Set InternetExplorerIntegrationLevel=1 through Group Policy or device management.'))

$zoneValues = 1..4 | ForEach-Object {
    (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\$_" -Name 2500 -ErrorAction SilentlyContinue).'2500'
}
$protectedModeAligned = ($zoneValues | Select-Object -Unique).Count -eq 1 -and $null -notin $zoneValues
$checks.Add((New-CheckResult 'protected-mode-aligned' $protectedModeAligned ($zoneValues -join ',') 'Align Protected Mode across Internet, Local intranet, Trusted sites, and Restricted sites.'))

$zoomFactor = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Internet Explorer\Zoom' -Name ZoomFactor -ErrorAction SilentlyContinue).ZoomFactor
$checks.Add((New-CheckResult 'ie-zoom-100-percent' ($zoomFactor -eq 100000) "$zoomFactor" 'Set Edge/IE zoom to 100% before capture.'))

$result = [pscustomobject]@{
    passed = -not ($checks.passed -contains $false)
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    checks = $checks
}

if ($Json) {
    $result | ConvertTo-Json -Depth 5
} else {
    $checks | Format-Table name, passed, value, remediation -AutoSize
}

if (-not $result.passed) { exit 1 }
