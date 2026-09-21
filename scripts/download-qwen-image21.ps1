param(
    [Parameter(Mandatory = $true)][string]$ModelRoot,
    [switch]$AcceptResearchLicense,
    [ValidateSet('all', 'diffusion', 'encoder', 'vae')][string]$Component = 'all'
)

$ErrorActionPreference = 'Stop'
if (-not $AcceptResearchLicense) {
    throw 'Qwen Image 2.1 is research/evaluation-only. Read https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE and pass -AcceptResearchLicense only if your use complies.'
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'curl.exe is required.' }
$modelDirectory = [IO.Path]::GetFullPath($ModelRoot)
$revision = 'ace0edeb3791a594ddfa36ed5f41a178a394e921'
$baseUrl = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/$revision"
$assets = @(
    @{ Kind = 'diffusion'; Path = 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors'; Bytes = 7256783064L; Hash = 'cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d' },
    @{ Kind = 'encoder'; Path = 'text_encoders/qwen3vl_8b_int8_convrot.safetensors'; Bytes = 9350798360L; Hash = '8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f' },
    @{ Kind = 'vae'; Path = 'vae/qwen_image_2.1_vae_bf16.safetensors'; Bytes = 675509688L; Hash = 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9' }
)

foreach ($asset in $assets) {
    if ($Component -ne 'all' -and $asset.Kind -ne $Component) { continue }
    $target = Join-Path $modelDirectory $asset.Path
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    $partial = "$target.partial"
    if (Test-Path -LiteralPath $target) {
        $candidate = $target
    } else {
        Write-Output "Downloading $($asset.Path) (resumable)"
        & curl.exe --fail --location --retry 4 --retry-delay 3 --continue-at - --silent --show-error --output $partial "$baseUrl/$($asset.Path)"
        if ($LASTEXITCODE -ne 0) { throw "Download failed; partial retained: $partial" }
        $candidate = $partial
    }
    if ((Get-Item -LiteralPath $candidate).Length -ne $asset.Bytes) { throw "Size mismatch: $candidate. File retained for inspection." }
    Write-Output "Checking SHA-256: $($asset.Path)"
    if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -ne $asset.Hash) { throw "SHA-256 mismatch: $candidate. File retained; not installed." }
    if ($candidate -eq $partial) { Move-Item -LiteralPath $partial -Destination $target }
    Write-Output "Verified: $target"
}
