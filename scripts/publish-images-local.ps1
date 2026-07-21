param(
    [string] $ImageTag = "0.0.1-alpha",
    [string] $RegistryOwner = "wsucauid798"
)

$ErrorActionPreference = "Stop"

$images = @(
    @{ Name = "api"; Context = "."; File = "services/api/Dockerfile" },
    @{ Name = "runtime"; Context = "."; File = "services/runtime/Dockerfile" },
    @{ Name = "account"; Context = "."; File = "services/account/Dockerfile" },
    @{ Name = "upps"; Context = "."; File = "services/upps/Dockerfile" },
    @{ Name = "realtime"; Context = "services/realtime"; File = "services/realtime/Dockerfile" },
    @{ Name = "ml"; Context = "services/ml"; File = "services/ml/Dockerfile" }
)

$token = gh auth token
if (-not $token) {
    throw "GitHub CLI is not authenticated. Run gh auth login first."
}

$token | docker login ghcr.io -u $RegistryOwner --password-stdin

foreach ($image in $images) {
    $fullName = "ghcr.io/$RegistryOwner/modbots-backend-$($image.Name):$ImageTag"
    docker build --file $image.File --tag $fullName $image.Context
    docker push $fullName
}
