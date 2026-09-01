[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $toolDir 'discord-secret.ps1')

$text = [Console]::In.ReadToEnd()
[Console]::Out.Write((Protect-DiscordSecret -Value $text))
