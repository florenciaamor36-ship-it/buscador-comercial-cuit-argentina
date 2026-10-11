# Buscador Comercial PRO — Android build

This Android wrapper packages the corrected search/CRM page as a local WebView app. It does **not** contain the Gemini API key.

## Security model

- Gemini requests go to the Cloudflare Worker in `worker/index.js`.
- `GEMINI_API_KEY` and `APP_ACCESS_TOKEN` are Worker secrets; do not add either value to this repository or the APK.
- The app asks for the separate access code at runtime and does not persist it.
- The Worker allowlists the Android asset origin and supported Gemini models, validates request sizes, and applies a per-IP best-effort rate limit.
- Restrict the Gemini key to the Generative Language API and set a conservative quota in Google AI Studio/Google Cloud.

## Build

The GitHub Actions workflow `.github/workflows/build-android-apk.yml` builds an installable debug APK and publishes it as the `buscador-comercial-pro-debug` artifact. The APK is a test build signed with Android's debug signing key, not a Play Store release.

## Deploying the proxy

Deploy `worker/index.js` as `buscador-comercial-gemini-proxy` with `worker/wrangler.toml`. Set these as Cloudflare Worker secrets (never as source variables):

- `GEMINI_API_KEY`: the Gemini key
- `APP_ACCESS_TOKEN`: a separate random access code entered by the user in the app

After deployment, set the public Worker base URL in `android/app/src/main/assets/config.js`, then rebuild the APK. The Worker URL is public configuration; the secret values are not.
