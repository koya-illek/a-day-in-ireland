# Check data operations

Run `npm run check:operations` against the canonical site. The command is read-only.
It reports the deployed commit, latest retained capture, degraded providers and river
fallback use. Exit 0 means the inspected sources and capture met the checks, 1 means
history is missing or over 45 minutes old, and 2 means a provider is unavailable.
A network or invalid-response error also exits unsuccessfully. Archive the JSON
outside the repository when comparing runs.

`/api/health` checks process response and configured binding presence. It does not
query storage or providers. Use the operations check to verify successful history
reads and capture freshness. Measured air is acquired separately by the browser,
so its Worker placeholder is excluded from provider failures.

If river coverage degrades, compare `providers.rivers.path` and observation time
with previous reports. Browser Run is a temporary path to OPW data. It must not be
labelled as a separate observation source. Investigate source-specific failures
before changing refresh frequencies or retaining older readings as current.

In the Cloudflare account, track Worker CPU and request counts, Browser Run use,
Durable Object use and D1 storage alongside billing. Account usage is not available
through the public API, and the script does not estimate costs. Set budget alerts
in the account when authorised. No alert service or scheduler is installed by this
repository change.
