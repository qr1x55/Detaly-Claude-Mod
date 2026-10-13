# Tails a job's log and writes ~/.claude/progress/<Id>.json for the Detaly mod, so the job needs no change.
# Exits when the count reaches the total, or when the log has been quiet for -IdleMin minutes. A log nobody holds open
# for writing any more, quiet for 30 s, is a stopped job (killed, or crashed past its last line): written as stopped.
# Defaults read rsl_rl logs ("Learning iteration 1234/3000", "ETA: 0:12:00"); counts start at the first iteration
# the log shows (a resumed run is 0 % at its start). -Absolute: take "k/N" as is (logs counting 1..N).
#   progress_tail.ps1 -Log D:\runs\train.log
#   progress_tail.ps1 -Log build.log -Id build -Pattern 'step (\d+) of (\d+)' -Eta '' -Unit step -Absolute
param(
    [Parameter(Mandatory)][string]$Log,
    [string]$Id = ([IO.Path]::GetFileNameWithoutExtension($Log) -replace '_train$', ''),
    [string]$Title = $Id,
    [string]$Pattern = 'Learning iteration (\d+)/(\d+)',     # groups: done, total
    [string]$Eta = 'ETA:\s*((?:\d+ days?, )?[\d:.]+)',      # group: "1 day, 2:03:04", "0:12:00", "75.5"; '' = none
    [string]$Unit = 'it',
    [switch]$Absolute,
    [int]$IdleMin = 30
)
$dir = Join-Path $env:USERPROFILE '.claude\progress'
$null = New-Item -ItemType Directory -Force $dir
# progress files nobody has written for a week go (the mod cannot delete files)
Get-ChildItem $dir -Filter *.json -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -ErrorAction SilentlyContinue
$dst = Join-Path $dir "$Id.json"
$tmp = "$dst.tmp"
$started = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$project = Split-Path ([IO.Path]::GetFullPath($Log))  # whose band shows it: the launching session, else this project

function Seconds([string]$s) {
    $d = 0
    if ($s -match '^(\d+) days?, (.*)$') { $d = [int]$Matches[1]; $s = $Matches[2] }
    $t = 0.0
    foreach ($p in $s.Split(':')) { $t = $t * 60 + [double]::Parse($p, [Globalization.CultureInfo]::InvariantCulture) }
    $d * 86400 + $t
}

# the job still has its log open: a share that denies writers is refused while one holds it
function Test-Writer {
    try { (([IO.File]::Open($Log, 'Open', 'Read', 'Read')).Close()); $false } catch { $true }
}

# `updated` is the log's last write, not this poll's: a dead job's row goes stalled, not on running
function Write-Job($done, $total, $eta, $finished, $updated, $stopped) {
    $job = [ordered]@{ title = $Title; done = $done; total = $total; unit = $Unit; started = $started; eta_s = $eta
        updated = $updated; finished = $finished; stopped = $stopped
        session = $env:CLAUDE_JOB_SESSION; project = $project }
    [IO.File]::WriteAllText($tmp, ($job | ConvertTo-Json -Compress))  # UTF-8, no BOM
    try {
        if (Test-Path $dst) { [IO.File]::Replace($tmp, $dst, [NullString]::Value) } else { [IO.File]::Move($tmp, $dst) }  # atomic
    } catch { }  # the mod is reading it this instant; the next round writes it
}

$base = $null
while ($true) {
    $t = Get-Content $Log -Tail 400 -ErrorAction SilentlyContinue
    $m = $t | Select-String $Pattern | Select-Object -Last 1
    if ($m) {
        $i = [double]$m.Matches[0].Groups[1].Value
        $n = [double]$m.Matches[0].Groups[2].Value
        if ($null -eq $base) {
            $base = 0
            if (-not $Absolute) {  # rsl_rl: iterations it..N-1 of a run resumed at `it`
                $first = Get-Content $Log -TotalCount 5000 | Select-String $Pattern | Select-Object -First 1
                $base = [double]$first.Matches[0].Groups[1].Value
            }
        }
        $done = if ($Absolute) { $i } else { $i + 1 - $base }
        $total = $n - $base
        $e = if ($Eta) { $t | Select-String $Eta | Select-Object -Last 1 }
        $etaS = if ($e) { Seconds $e.Matches[0].Groups[1].Value } else { $null }
    }
    $li = Get-Item $Log -ErrorAction SilentlyContinue
    $last = if ($li) { $li.LastWriteTime } else { [DateTimeOffset]::FromUnixTimeSeconds($started).LocalDateTime }
    $quiet = ((Get-Date) - $last).TotalSeconds
    if ($m) {
        $finished = $done -ge $total
        $stopped = -not $finished -and $quiet -gt 30 -and -not (Test-Writer)
        Write-Job $done $total $etaS $finished ([DateTimeOffset]::new($last).ToUnixTimeSeconds()) $stopped
        if ($finished -or $stopped) { break }
    }
    if ($quiet -gt $IdleMin * 60) { break }  # open but silent: the mod shows it stalled, then drops it
    Start-Sleep 2
}
