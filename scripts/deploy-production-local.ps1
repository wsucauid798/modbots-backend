$ErrorActionPreference = "Stop"

throw "Production deploys must run through GitHub CI. Test locally, then push the release branch so the backend pipeline verifies and deploys it."
