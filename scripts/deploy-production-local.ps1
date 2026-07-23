$ErrorActionPreference = "Stop"

throw "Production deploys must run through GitHub CI. Test locally, push to GitHub, let CI pass, then run the Deploy Backend workflow."
