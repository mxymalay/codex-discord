Set-StrictMode -Version Latest

$script:DiscordBotUserAgent = 'DiscordBot (https://github.com/openai/codex, 1.0.0)'

function New-DiscordBotHeaders {
    param([Parameter(Mandatory)][string]$Token)

    return @{
        Authorization = "Bot $Token"
        'User-Agent' = $script:DiscordBotUserAgent
    }
}
