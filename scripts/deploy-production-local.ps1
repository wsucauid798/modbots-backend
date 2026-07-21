param(
    [string] $ImageTag = "0.0.1-alpha",
    [string] $SshHost = "modbots-vps",
    [string] $RemotePath = "/opt/modbots/backend",
    [string] $RegistryOwner = "wsucauid798",
    [switch] $LoginGhcr
)

$ErrorActionPreference = "Stop"

ssh $SshHost "mkdir -p '$RemotePath'"
scp docker-compose.production.yml "${SshHost}:$RemotePath/docker-compose.yml"
scp scripts/deploy-production.sh "${SshHost}:$RemotePath/deploy-production.sh"
ssh $SshHost "chmod +x '$RemotePath/deploy-production.sh'"

if ($LoginGhcr) {
    $token = gh auth token
    if (-not $token) {
        throw "GitHub CLI is not authenticated. Run gh auth login first."
    }

    $token | ssh $SshHost "docker login ghcr.io -u '$RegistryOwner' --password-stdin"
}

ssh $SshHost "cd '$RemotePath' && MODBOTS_IMAGE_TAG='$ImageTag' ./deploy-production.sh"
