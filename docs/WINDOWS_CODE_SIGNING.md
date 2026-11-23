# Windows Authenticode Code Signing (Azure Trusted Signing)

`Gimel-Setup-x64.exe` and `gimel.exe` are built automatically in `.github/workflows/package-release.yml` using PyInstaller `--onedir` + Inno Setup 6.

To eliminate **Microsoft Edge SmartScreen** (*"wird nicht häufig heruntergeladen"*) and **Windows Defender** warnings permanently for all Windows users, enable **Microsoft Azure Trusted Signing** in GitHub Actions. The workflow already has the signing steps pre-wired — they activate automatically as soon as the GitHub Secrets & Variables below are set.

## 1. Create an Azure Trusted Signing Account (~$9.99/month)

1. Open the [Azure Portal](https://portal.azure.com/) and create a **Trusted Signing Account** (choose **West Europe** or **North Europe**, endpoint e.g. `https://weu.codesigning.azure.net`).
2. Complete **Identity Validation** for your organization (**FyreFly Systems GbR**, Germany).
3. Create a **Certificate Profile** of type **Public Trust** (e.g. `gimel-public-trust`).
4. Create an **App Registration** in Microsoft Entra ID:
   - Assign it the **Trusted Signing Certificate Profile Signer** role on your Trusted Signing Account.
   - Under **Certificates & secrets → Federated credentials → Add credential**, choose **GitHub Actions deploying Azure resources**:
     - Organization: `mxsp`
     - Repository: `gimel`
     - Entity type: **Tag** (or **Branch `main`** / **Environment `release`**)

## 2. Configure GitHub Actions Secrets & Variables

In `https://github.com/mxsp/gimel/settings/secrets/actions`:

### Repository Secrets
| Secret Name | Value |
|---|---|
| `AZURE_CLIENT_ID` | Entra ID App Registration Application (client) ID |
| `AZURE_TENANT_ID` | Entra ID Directory (tenant) ID |
| `AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |

### Repository Variables
| Variable Name | Example Value |
|---|---|
| `AZURE_SIGNING_ENDPOINT` | `https://weu.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | `fyrefly-gimel-signing` |
| `AZURE_SIGNING_PROFILE` | `gimel-public-trust` |

## 3. Trigger a Release

Push a new tag (e.g. `git tag -a v0.2.5 -m "Gimel v0.2.5" && git push origin v0.2.5`). GitHub Actions will automatically:

1. Build the Windows `--onedir` bundle (`gimel.exe` + `_internal/`).
2. Authenticate via OIDC (`azure/login@v2`) with zero long-lived secrets.
3. Sign `gimel.exe` with `azure/trusted-signing-action@v0.5.9` + RFC 3161 timestamp (`http://timestamp.acs.microsoft.com`).
4. Package the signed `gimel.exe` into `Gimel-Setup-x64.exe` via Inno Setup.
5. Sign `Gimel-Setup-x64.exe` with `azure/trusted-signing-action@v0.5.9`.
6. Publish the signed `Gimel-Setup-x64.exe`, `gimel-windows-x64.zip`, `gimel-linux-x64.tar.gz`, and `SHA256SUMS.txt` to GitHub Releases.
