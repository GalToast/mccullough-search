<#
.SYNOPSIS
Run lead search via GitHub Actions

.DESCRIPTION
Triggers the search-lead workflow on GitHub Actions, waits for completion,
downloads the result artifact, and displays findings.

.PARAMETER LeadName
Business name to search for (required)

.PARAMETER City
City for location context

.PARAMETER State
State code (default: TX)

.PARAMETER Zip
ZIP code for location context

.PARAMETER MaxQueries
Maximum search queries per lead (default: 3)

.PARAMETER MinScore
Minimum score threshold (default: 15)

.PARAMETER Repo
GitHub repo in owner/name format (default: GalToast/mccullough-search)

.EXAMPLE
.\run-search-gh.ps1 -LeadName "Good Charlie's Conroe" -City "Conroe" -State "TX"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$LeadName,
    
    [string]$City = "",
    [string]$State = "TX",
    [string]$Zip = "",
    [int]$MaxQueries = 3,
    [int]$MinScore = 15,
    [string]$Repo = "GalToast/mccullough-search"
)

# Colors
function Write-Step { Write-Host "`n► $args" -ForegroundColor Cyan }
function Write-Success { Write-Host "  ✓ $args" -ForegroundColor Green }
function Write-Info { Write-Host "  $args" -ForegroundColor White }

Write-Step "Triggering search workflow..."

# Trigger workflow
$runOutput = gh workflow run search-lead.yml `
    --repo $Repo `
    -f lead_name="$LeadName" `
    -f city="$City" `
    -f state="$State" `
    -f zip_code="$Zip" `
    -f max_queries=$MaxQueries `
    -f min_score=$MinScore `
    2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error triggering workflow: $runOutput" -ForegroundColor Red
    exit 1
}

Write-Success "Workflow triggered"

# Wait for run to start
Write-Step "Waiting for workflow run..."
Start-Sleep -Seconds 5

# Find the run
$runs = gh run list --repo $Repo --workflow=search-lead.yml --limit 5 --json databaseId,status,conclusion,displayTitle
$runId = ($runs | ConvertFrom-Json)[0].databaseId

Write-Info "Run ID: $runId"

# Wait for completion
Write-Step "Waiting for completion..."
gh run watch $runId --repo $Repo --exit-status

if ($LASTEXITCODE -ne 0) {
    Write-Host "Workflow failed!" -ForegroundColor Red
    exit 1
}

Write-Success "Workflow completed"

# Download artifact
Write-Step "Downloading result..."
gh run download $runId --repo $Repo --name search-result --dir ./search-result-temp

if (Test-Path "./search-result-temp/search-result.json") {
    $result = Get-Content "./search-result-temp/search-result.json" | ConvertFrom-Json
    
    Write-Host "`n========== SEARCH RESULT ==========" -ForegroundColor Yellow
    Write-Host "Status: $($result.status)" -ForegroundColor White
    Write-Host "Lead: $($result.lead_name)" -ForegroundColor White
    Write-Host "Queries: $($result.queries_attempted)" -ForegroundColor White
    Write-Host "Candidates: $($result.candidates_found)" -ForegroundColor White
    
    if ($result.best_match) {
        Write-Host "`nBEST MATCH:" -ForegroundColor Green
        Write-Host "  Score: $($result.best_match.score)" -ForegroundColor White
        Write-Host "  URL: $($result.best_match.url)" -ForegroundColor White
        Write-Host "  Domain: $($result.best_match.domain)" -ForegroundColor White
        Write-Host "  Title: $($result.best_match.title)" -ForegroundColor White
    }
    
    Write-Host "`n===================================" -ForegroundColor Yellow
    
    # Cleanup
    Remove-Item -Recurse -Force ./search-result-temp
} else {
    Write-Host "No result artifact found" -ForegroundColor Red
}