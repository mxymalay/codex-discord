[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $toolDir 'discord-secret.ps1')

$ciphertext = [Console]::In.ReadToEnd()
[Console]::Out.Write((Unprotect-DiscordSecret -Ciphertext $ciphertext))
